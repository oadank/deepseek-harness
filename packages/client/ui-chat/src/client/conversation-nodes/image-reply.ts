import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ImageReplyChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Assistant's sent image, persisted as an independent image row. */
    'image-reply': ImageReplyChatData
  }
}

interface ImageReplyState {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly image: ImageReplyChatData['image']
}

function stateFrom(match: ConversationMatch): ImageReplyState | undefined {
  if (match.event.type !== 'image/reply') return undefined
  const { turn, attachmentId, mediaType, bytes, width, height, alt } = match.event.data as {
    turn: number
    attachmentId: string
    mediaType: string
    bytes: number
    width?: number
    height?: number
    alt?: string
  }
  return {
    turn,
    seq: match.event.seq,
    time: match.event.time,
    image: {
      attachmentId,
      mediaType,
      bytes,
      width: width ?? 1,
      height: height ?? 1,
      ...(typeof alt === 'string' && alt !== '' ? { name: alt } : {}),
    },
  }
}

/**
 * [本地改造 2026-08-23 / 0.1.5 已迁移] Assistant image-reply as its own chat row.
 */
export const imageReplyDefinition: ConversationNodeDefinition<ImageReplyState> = {
  kind: 'image-reply',
  target: 'chat',
  match: (event) => {
    if (event.type === 'image/reply') return { id: String(event.seq), role: 'start' }
    return null
  },
  start: (_context, match) => {
    const state = stateFrom(match)
    if (state === undefined) throw new Error('image-reply start requires an image/reply event')
    return state
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const data: ImageReplyChatData = { turn: state.turn, seq: state.seq, time: state.time, image: state.image }
    return chatNode(context, 'image-reply', state.seq, data)
  },
}

/**
 * Register the assistant image-reply contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerImageReplyConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(imageReplyDefinition)
}
