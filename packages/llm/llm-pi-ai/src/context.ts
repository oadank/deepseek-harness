/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */

import { CallId, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'
import { join } from 'node:path'

/** [本地改造 2026-08-16] 把已转为文本的内容块扁平化为纯文本（非视觉模型路径）。 */
function flattenBlocks(blocks: readonly ContentBlock[]): string {
  let out = ''
  for (const block of blocks) {
    if (block.type === 'text') {
      out += block.text
    } else if (block.type === 'voice') {
      const asText = voiceAsText(block)
      if (asText.type === 'text') out += asText.text
    } else if (block.type === 'tool-result') {
      out += flattenBlocks(block.content)
    }
    // image 已在 imagesToText 转成 text，此处不再出现。
  }
  return out
}

/**
 * [本地改造 2026-08-16] 把 voice 块转成文本：attachment.transcript 存在时直接给出
 * 识别文本；否则输出本地语音文件路径——与 llm-deepseek serialize.ts 的 voiceAsText
 * 同一策略，保证切换 provider（deepseek-official ↔ qwen/pi-ai）后语音识别行为一致。
 */
function voiceAsText(block: ContentBlock): ContentBlock {
  if (block.type !== 'voice') return block
  const ref = (block as { attachment?: { voiceId?: unknown; durationMs?: unknown; transcript?: unknown } }).attachment
  const rawId = typeof ref?.voiceId === 'string' ? ref.voiceId : ''
  const hex = rawId.startsWith('sha256:') ? rawId.slice('sha256:'.length) : rawId
  const transcript = typeof ref?.transcript === 'string' && ref.transcript.length > 0
    ? ref.transcript
    : null
  const durationMs = typeof ref?.durationMs === 'number' ? ref.durationMs : null
  const duration = durationMs === null ? '' : `（时长 ${Math.round(durationMs / 1000)} 秒）`
  if (transcript !== null) {
    return { type: 'text', text: `[用户发送了一条语音${duration}，识别内容：${transcript}]` }
  }
  const home = process.env.DSH_HOME ?? ''
  const path = hex.length > 0 && home !== ''
    ? join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex)
    : '(unknown)'
  return { type: 'text', text: `[用户发送了一条语音${duration}，本地语音文件路径: ${path}]` }
}

/**
 * [本地改造 2026-08-16] 把 image 块转成含本地附件路径的文本（与 llm-deepseek
 * serialize.ts 的 imageAsText 同一策略）：非视觉模型（pi-ai input 不含 image）
 * 收到路径文本后，必须通过视觉 MCP（mcp__visionqa__look / mcp__zai-vision__analyze_image）
 * 识图。路径带扩展名（jpeg→.jpg / png→.png / webp→.png，attachment-local 存储时已生成
 * 带扩展名别名，见 store.ts extensionAliasPath），zai-vision 等按扩展名校验的工具可用。
 */
function imageAsText(block: ContentBlock): ContentBlock {
  if (block.type !== 'image') return block
  const ref = (block as { attachment?: { attachmentId?: unknown; name?: unknown; mediaType?: unknown } }).attachment
  const rawId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : ''
  const hex = rawId.startsWith('sha256:') ? rawId.slice('sha256:'.length) : rawId
  const name = typeof ref?.name === 'string' && ref.name.length > 0 ? ref.name : 'image'
  const mediaType = typeof ref?.mediaType === 'string' ? ref.mediaType : 'image/jpeg'
  const home = process.env.DSH_HOME ?? ''
  const ext = mediaType === 'image/jpeg' ? '.jpg' : '.png'
  const path = hex.length > 0 && home !== ''
    ? join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex) + ext
    : '(unknown)'
  return { type: 'text', text: `[用户发送了一张图片，名称 "${name}"，类型 ${mediaType}。请用视觉 MCP 工具识图（mcp__visionqa__look 或 mcp__zai-vision__analyze_image，传入 image_path）：${path}]` }
}

/** Convert image blocks to path-text when the route model is not a vision model. */
function imagesToText(blocks: readonly ContentBlock[], vision: boolean): readonly ContentBlock[] {
  if (vision) return blocks
  const out: ContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image') {
      out.push(imageAsText(block))
    } else if (block.type === 'tool-result') {
      out.push({ ...block, content: [...imagesToText(block.content, vision)] })
    } else {
      out.push(block)
    }
  }
  return out
}

async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  vision: boolean,
): Promise<string | (TextContent | ImageContent)[]> {
  // [本地改造 2026-08-16] 非视觉模型：图片块先整体转路径文本（agent 用视觉 MCP 看图），
  // 不再需要 attachments；视觉模型保持原逻辑（读原图送 pi-ai）。
  const converted = imagesToText(blocks, vision)
  if (!vision) {
    return flattenBlocks(converted)
  }
  const content: (TextContent | ImageContent)[] = []
  for (const block of converted) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'voice': {
        // [本地改造 2026-08-16] 语音块转文本（识别文本/本地路径），与文本块同路进模型。
        const asText = voiceAsText(block)
        if (asText.type === 'text' && asText.text.length > 0) {
          content.push({ type: 'text', text: asText.text })
        }
        break
      }
      case 'image': {
        if (attachments === undefined) {
          throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
        }
        const stored = await attachments.readImage(block.attachment)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
        break
      }
      case 'tool-result':
        {
          const nested = await userContent(block.content, attachments, vision)
          if (typeof nested === 'string') {
            if (nested.length > 0) content.push({ type: 'text', text: nested })
          } else {
            content.push(...nested)
          }
        }
        break
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function textOnlyContext(options: GenerateOptions, vision: boolean): PiContext {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      // 视觉模型无法在 pi-ai 单一 systemPrompt 槽内表达图片；非视觉模型
      // （vision=false）走文本路径（imagesToText 转路径文本）。
      if (vision && contentHasImage(message.content)) {
        throw new LlmError('pi-ai cannot represent an image in an in-history system message', 'UNSUPPORTED_CONTENT')
      }
      messages.push({ role: 'user', content: flattenBlocks(imagesToText(message.content, vision)), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      messages.push(assistant)
      continue
    }
    const regular = message.content.filter(block => block.type !== 'tool-result')
    // [本地改造 2026-08-16] 非视觉模型（vision=false）：图片块转路径文本后扁平化；
    // 视觉模型（vision=true）无 durable attachment 服务时仍拒绝（必须读原图）。
    if (vision && contentHasImage(regular)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const text = flattenBlocks(imagesToText(regular, vision))
    const results = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
    for (const result of results) {
      if (vision && contentHasImage(result.content)) {
        throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{
          type: 'text',
          text: flattenBlocks(imagesToText(result.content, vision)) || '(no output)',
        }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return piContext(options, messages)
}

/**
 * Convert harness history to a pi-ai Context while resolving durable images.
 * Tool result names are recovered from preceding assistant tool calls.
 * [本地改造 2026-08-16] vision=false（模型 input 不含 image）时，图片块转为
 * 本地路径文本（agent 用视觉 MCP 识图），与 llm-deepseek serialize.ts 一致；
 * attachments 可为 undefined（非视觉路径不需要 durable attachment 服务）。
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param attachments - durable byte resolver for image references (vision models); optional.
 * @param vision - whether the route model accepts image input.
 * @returns the asynchronously resolved pi-ai context.
 */
export function toPiContext(options: GenerateOptions, attachments?: undefined, vision?: boolean): PiContext
export function toPiContext(options: GenerateOptions, attachments: AttachmentStore, vision?: boolean): Promise<PiContext>
export function toPiContext(options: GenerateOptions, attachments?: AttachmentStore, vision = true): PiContext | Promise<PiContext> {
  return attachments === undefined ? textOnlyContext(options, vision) : toPiContextWithImages(options, attachments, vision)
}

async function toPiContextWithImages(options: GenerateOptions, attachments: AttachmentStore, vision: boolean): Promise<PiContext> {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []

  for (const message of options.messages) {
    if (message.role === 'system') {
      // 视觉模型无法在 pi-ai 单一 systemPrompt 槽内表达图片；非视觉模型
      // （vision=false）走文本路径（imagesToText 转路径文本）。
      if (vision && contentHasImage(message.content)) {
        throw new LlmError('pi-ai cannot represent an image in an in-history system message', 'UNSUPPORTED_CONTENT')
      }
      // pi-ai has a single systemPrompt slot; in-history system messages are
      // folded into user messages to preserve order (rare in practice — the
      // harness sends the system prompt via options.system).
      messages.push({ role: 'user', content: flattenBlocks(imagesToText(message.content, vision)), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      }
      messages.push(assistant)
      continue
    }
    // user role: text + tool results (each result becomes its own message).
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const content = await userContent(regular, attachments, vision)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      const resultContent = await userContent(result.content, attachments, vision)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string'
          ? [{ type: 'text', text: resultContent || '(no output)' }]
          : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }

  return piContext(options, messages)
}
