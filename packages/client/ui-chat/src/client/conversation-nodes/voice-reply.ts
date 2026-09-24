import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { VoiceReplyChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Assistant's synthesized voice reply, persisted beside the user's voice messages. */
    'voice-reply': VoiceReplyChatData
  }
}

interface VoiceReplyState {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly voice: VoiceReplyChatData['voice']
}

function stateFrom(match: ConversationMatch): VoiceReplyState | undefined {
  if (match.event.type !== 'voice/reply') return undefined
  const { turn, voiceId, mediaType, bytes, durationMs, transcript } = match.event.data as {
    turn: number
    voiceId: string
    mediaType: string
    bytes: number
    durationMs?: number
    transcript?: string
  }
  return {
    turn,
    seq: match.event.seq,
    time: match.event.time,
    voice: {
      voiceId,
      mediaType,
      bytes,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(typeof transcript === 'string' && transcript !== '' ? { transcript } : {}),
    },
  }
}

/**
 * [本地改造 2026-08-16 / 0.1.5 已迁移] Assistant voice-reply as its own chat row.
 * Match id is the event seq so multiple voice replies per turn stay unique.
 */
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
  ctx.uiConversation.events.register(voiceReplyDefinition)
}
