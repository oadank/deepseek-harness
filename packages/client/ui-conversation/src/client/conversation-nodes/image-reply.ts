import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { chatNode } from './common.ts'

/** One assistant image-reply row's durable payload (from the image/reply event). */
export interface ImageReplyChatData {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly image: ImageAttachmentRef
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Assistant's sent image, persisted as an independent image row. */
    'image-reply': ImageReplyChatData
  }
}

interface ImageReplyState {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly image: ImageAttachmentRef
}

function stateFrom(match: ConversationMatch): ImageReplyState | undefined {
  if (match.event.type !== 'image/reply') return undefined
  const { turn, attachmentId, mediaType, bytes, width, height, alt } = match.event.data
  return {
    turn,
    seq: match.event.seq,
    time: match.event.time,
    image: {
      attachmentId: attachmentId as AttachmentId,
      mediaType: mediaType as ImageAttachmentRef['mediaType'],
      bytes,
      width: width ?? 1,
      height: height ?? 1,
      ...(typeof alt === 'string' && alt !== '' ? { name: alt } : {}),
    },
  }
}

/**
 * [本地改造 2026-08-23] 助手主动发的图片作为独立横条：跟随 image/reply 事件渲染，
 * 与用户图片消息同级持久化（可点开放大、可翻查），不混在文字回复里。
 * 同一 turn 可有多条图片回复，match id 用事件 seq 保证每条唯一。
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
    if (state === undefined) throw new Error('image-reply start requires a image/reply event')
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
  ctx.conversationEvents.register(imageReplyDefinition)
}
