/**
 * Serialize harness messages into DeepSeek chat completions. User text is joined; assistant text
 * becomes `content`, tool calls become `tool_calls`, and tool results become separate tool messages.
 * Assistant reasoning is replayed as `reasoning_content` only on tool-call turns, as required by
 * thinking-mode passback. Core image blocks are rejected explicitly because this wire route is text-only;
 * unknown declaration-merged block types retain the adapter's documented extension fallback.
 * @module dsh-llm-deepseek/serialize
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireTool } from './types.ts'
import { join } from 'node:path'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'high' | 'max' | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'high' | 'max'
}

/** Validate the adapter-owned effort before resolving its DeepSeek wire fields. */
function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'high' | 'max' {
  if (effort === 'off' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'high' | 'max'
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
  if (effort === 'high' || effort === 'max') {
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
 * 文本模型收到路径后，通过视觉 MCP（look 工具）识图；tool-result 里嵌套的图片同样处理。 */
function imageAsText(block: ContentBlock): ContentBlock {
  const ref = (block as { attachment?: { attachmentId?: unknown; name?: string; mediaType?: string } }).attachment
  const rawId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : ''
  const hex = rawId.startsWith('sha256:') ? rawId.slice('sha256:'.length) : rawId
  const name = typeof ref?.name === 'string' && ref.name.length > 0 ? ref.name : 'image'
  const mediaType = ref?.mediaType ?? 'image/jpeg'
  const home = process.env.DSH_HOME ?? ''
  const path = hex.length > 0 && home !== ''
    ? join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex)
    : '(unknown)'
  return { type: 'text', text: `[用户发送了一张图片，名称 "${name}"，类型 ${mediaType}，本地文件路径: ${path}]` }
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
    // Official passback rule (guides/thinking_mode.mdx): reasoning_content
    // must return on tool-call turns; it is ignored on plain turns, so we
    // drop it there to save tokens.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
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

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  // A short title budget must produce visible text; conversation and
  // compaction calls continue to inherit the adapter's thinking defaults.
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
