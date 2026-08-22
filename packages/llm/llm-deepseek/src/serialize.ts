/**
 * Serialize harness messages into DeepSeek chat completions. Text-only
 * requests retain string user content; the image path resolves durable
 * attachments into ordered data-URL parts. Tool-result images follow their
 * string-only tool messages in a separate user message.
 * @module dsh-llm-deepseek/serialize
 */

import { contentHasImage, LlmError, offloadRequestImages } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  WireImageContentPart,
  WireMessage,
  WireRequest,
  WireTool,
  WireUserContentPart,
} from './types.ts'
import { join } from 'node:path'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'low' | 'high' | 'max'
}

/** Dependencies required only when the request contains image input. */
export interface ImageSerializationOptions {
  /** Durable resolver for canonical image references. */
  attachments: AttachmentStore
  /** Positive bound on accumulated base64 image payload. */
  maxRequestImageBytes: number
  /** Cancellation shared with the provider request. */
  signal: AbortSignal
}

const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/** Validate the adapter-owned effort before resolving its DeepSeek wire fields. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'low' | 'high' | 'max' {
  if (effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'low' | 'high' | 'max'
  }
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/** Resolve one legal thinking/effort pair without exposing `off` as a wire effort. */
function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `DeepSeek deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'low' || effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** [本地改造 2026-08-16] 把 image 块转成含本地附件路径的文本（参考 dsh-vscode-layout 补丁）：
 * 文本模型收到路径后，必须通过视觉 MCP（mcp__visionqa__look / mcp__zai-vision__analyze_image）
 * 识图。路径带扩展名（jpeg→.jpg / png→.png / webp→.png，attachment-local 存储时已生成
 * 带扩展名别名，见 store.ts extensionAliasPath），zai-vision 等按扩展名校验的工具可用。 */
function imageAsText(block: ContentBlock): ContentBlock {
  const ref = (block as { attachment?: { attachmentId?: unknown; name?: string; mediaType?: string } }).attachment
  const rawId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : ''
  const hex = rawId.startsWith('sha256:') ? rawId.slice('sha256:'.length) : rawId
  const name = typeof ref?.name === 'string' && ref.name.length > 0 ? ref.name : 'image'
  const mediaType = ref?.mediaType ?? 'image/jpeg'
  const home = process.env.DSH_HOME ?? ''
  const ext = mediaType === 'image/jpeg' ? '.jpg' : '.png'
  const path = hex.length > 0 && home !== ''
    ? join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex) + ext
    : '(unknown)'
  return { type: 'text', text: `[用户发送了一张图片，名称 "${name}"，类型 ${mediaType}，本地路径 ${path}。识图请优先调用 modlens_read_image 工具（path 参数填这个路径，普通描述可传简短 prompt 如"简要描述这张图"）。若用户要求像素级反推/详细复现描述：先读取文件 ${join(home, 'visionqa-reverse-prompt.txt')}，把该文件内容作为 prompt 参数传给 modlens_read_image。仅当 modlens_read_image 不可用时，才改用 mcp__visionqa__look 或 mcp__zai-vision__analyze_image]` }
}

function imagesAsText(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === 'image') return imageAsText(block)
    if (block.type === 'tool-result') return { ...block, content: imagesAsText(block.content) }
    return block
  })
}

/** [本地改造 2026-08-16] 把 voice 块转成文本：attachment.transcript 存在时直接给出
 * 识别文本（旧宿主链路兼容）；否则输出本地语音文件路径——agent 收到路径后主动调
 * 本地 ASR 服务识别（与图片走视觉 MCP 同一模式），识别结果显示在助手侧。 */
function voiceAsText(block: ContentBlock): ContentBlock {
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

function voicesAsText(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === 'voice') return voiceAsText(block)
    if (block.type === 'tool-result') return { ...block, content: voicesAsText(block.content) }
    return block
  })
}

/** Reject roles whose DeepSeek history format cannot carry image input. */
function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The DeepSeek chat-completions adapter cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Resolve one durable image into its transient DeepSeek data-URL part. */
async function imagePart(
  block: Extract<ContentBlock, { type: 'image' }>,
  attachments: AttachmentStore,
  signal: AbortSignal,
): Promise<WireImageContentPart> {
  try {
    const stored = await attachments.readImage(block.attachment, signal)
    return {
      type: 'image_url',
      image_url: {
        url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
      },
    }
  } catch (error: unknown) {
    if (error instanceof AttachmentError) {
      throw new LlmError(error.message, error.code, { cause: error })
    }
    throw error
  }
}

/** Convert user or nested tool-result blocks into ordered wire parts. */
async function contentParts(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
  signal: AbortSignal,
): Promise<WireUserContentPart[]> {
  const parts: WireUserContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        parts.push(await imagePart(block, attachments, signal))
        break
      case 'tool-result':
        parts.push(...await contentParts(block.content, attachments, signal))
        break
      default:
        // Other merge-extensible blocks are not DeepSeek user-input vocabulary.
        break
    }
  }
  return parts
}

/** Keep text-only user messages on the compact string wire form. */
function userContent(parts: readonly WireUserContentPart[]): string | WireUserContentPart[] {
  const text: string[] = []
  for (const part of parts) {
    if (part.type === 'image_url') return [...parts]
    text.push(part.text)
  }
  return text.join('')
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // official samples replay message.content verbatim (which is "") and
    // some gateways reject null outright. Reasoning-ONLY turns (the model
    // can answer entirely in the reasoning channel, e.g. a v4-flash
    // greeting): the live API rejects null-content/no-tool_calls assistant
    // messages with a 400 ("content or tool_calls must be set"), and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // CoT passback on every reasoning-carrying turn. The official rule
    // (guides/thinking_mode.mdx) requires it on tool-call turns and ignores it
    // elsewhere; a gateway re-encoding the conversation for another vendor
    // recovers that turn's upstream thinking signature by hashing this exact
    // text, which a tool-call-free turn carries nowhere else.
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    // [本地改造 2026-08-16] 图片块先转本地路径文本（imagesAsText），agent 用视觉 MCP 识图；
    // 语音块同样转本地路径文本（voicesAsText），agent 用本地 ASR 服务识别——识别结果
    // 以工具输出显示在助手侧（与识图同一模式），host 不再二次注入识别文本。
    const content = voicesAsText(imagesAsText(message.content))
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant({ ...message, content }))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but DeepSeek wants them as role:'tool' messages.
    const toolResults = content.filter(block => block.type === 'tool-result')
    const text = flattenText(content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Serialize image-capable history after resolving durable attachments.
 * Consecutive tool results keep string `tool` messages and share one following
 * user message containing their images.
 * @param messages - transient request history after request-size offloading.
 * @param attachments - durable image resolver.
 * @param signal - cancellation for attachment reads.
 * @returns ordered DeepSeek wire messages.
 */
export async function serializeMessagesWithImages(
  messages: readonly Message[],
  attachments: AttachmentStore,
  signal: AbortSignal,
): Promise<WireMessage[]> {
  assertSupportedImageRoles(messages)
  const wire: WireMessage[] = []
  let pendingToolImages: WireImageContentPart[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of messages) {
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }

    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => (
      block.type === 'tool-result'
    ))
    const content = userContent(await contentParts(regular, attachments, signal))
    if (content.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({
        role: 'user',
        content,
      })
    }
    for (const result of toolResults) {
      const parts = await contentParts(result.content, attachments, signal)
      const images = parts.filter((part): part is WireImageContentPart => part.type === 'image_url')
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('')
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: text || (images.length > 0 ? '(see attached image)' : '(no output)'),
      })
      pendingToolImages.push(...images)
    }
  }
  flushToolImages()
  return wire
}

/** Assemble request fields shared by text-only and image-capable conversion. */
function requestWithMessages(
  options: GenerateOptions,
  messages: WireMessage[],
  defaults: RequestDefaults,
): WireRequest {
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const resolvedThinking = resolveThinking(options, defaults)
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  return requestWithMessages(options, messages, defaults)
}

/**
 * Build one image-capable request while keeping durable bytes out of session
 * messages. Oversized oldest images become deterministic text before any
 * attachment read.
 * @param options - harness request containing image-capable user content.
 * @param images - attachment resolver, request bound, and cancellation.
 * @param defaults - adapter-level thinking defaults.
 * @returns the fully materialized DeepSeek request body.
 */
export async function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
  defaults: RequestDefaults = {},
): Promise<WireRequest> {
  assertSupportedImageRoles(options.messages)
  const requestMessages = offloadRequestImages(options.messages, images.maxRequestImageBytes)
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...await serializeMessagesWithImages(requestMessages, images.attachments, images.signal))
  return requestWithMessages(options, messages, defaults)
}
