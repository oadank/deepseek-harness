// VoiceReplyNodeView: the assistant's synthesized voice reply as its own
// durable chat row — a standalone voice bar (play button + duration), mirroring
// the user's voice messages instead of being buried inside the text reply.

import { memo } from 'react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { VoiceCard } from './MessageItem.tsx'
import css from './MessageItem.module.css'

/** Assistant voice-reply keyed Chat renderer: one standalone voice bar. */
export const VoiceReplyNodeView = memo(function VoiceReplyNodeView({
  node, loadVoice, t,
}: ChatNodeViewProps<'voice-reply'>) {
  const { voice } = node.data
  return (
    // [本地改造 2026-08-27] data-voice-id：暴露稳定的语音对象标识，供插件按 voiceId
    // 持久化「已自动播放」记录（localStorage），实现只播新语音、重开页面不重播历史。
    <div className={css.voiceReplyRow} data-voice-reply data-voice-id={voice.voiceId}>
      <VoiceCard attachment={voice} load={loadVoice} t={t} />
    </div>
  )
})
