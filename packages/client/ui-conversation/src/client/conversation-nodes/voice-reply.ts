import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { VoiceAttachmentRef } from '@deepseek-ai/dsh-client-connection/client'
import { chatNode } from './common.ts'

/** One assistant voice-reply row's durable payload (from the voice/reply event). */
export interface VoiceReplyChatData {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly voice: VoiceAttachmentRef
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Assistant's synthesized voice reply, persisted beside the user's voice messages. */
    'voice-reply': VoiceReplyChatData
  }
}

interface VoiceReplyState {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly voice: VoiceAttachmentRef
}

function stateFrom(match: ConversationMatch): VoiceReplyState | undefined {
  if (match.event.type !== 'voice/reply') return undefined
  const { turn, voiceId, mediaType, bytes, durationMs, transcript } = match.event.data
  return {
    turn,
    seq: match.event.seq,
    time: match.event.time,
    voice: {
      voiceId,
      mediaType: mediaType as VoiceAttachmentRef['mediaType'],
      bytes,
      ...(durationMs === undefined ? {} : { durationMs }),
      // [本地改造 2026-08-21] AI 语音回复的转写文本（合成的正文），供语音条显示与复制
      ...(typeof transcript === 'string' && transcript !== '' ? { transcript } : {}),
    },
  }
}

/** [本地改造 2026-08-16] 助手语音回复独立横条：跟随 voice/reply 事件渲染，
 * 与用户语音消息同级持久化（可回放、可翻查），不混在文字回复里。
 * 同一 turn 可有多条语音回复（自动回复 + 主动发送），match id 用事件 seq
 * 保证每条唯一，避免 assembler "more than one start Match" 崩溃。 */
export const voiceReplyDefinition: ConversationNodeDefinition<VoiceReplyState> = {
  kind: 'voice-reply',
  target: 'chat',
  match: (event) => {
    if (event.type === 'voice/reply') return { id: String(event.seq), role: 'start' }
    return null
  },
  start: (_context, match) => {
    const state = stateFrom(match)
    if (state === undefined) throw new Error('voice-reply start requires a voice/reply event')
    return state
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const data: VoiceReplyChatData = { turn: state.turn, seq: state.seq, time: state.time, voice: state.voice }
    return chatNode(context, 'voice-reply', state.seq, data)
  },
}

/**
 * Register the assistant voice-reply contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerVoiceReplyConversationNode(ctx: Context): void {
  ctx.conversationEvents.register(voiceReplyDefinition)
}
