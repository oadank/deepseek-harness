// VoiceReplyNodeView: assistant's synthesized voice reply as its own durable
// chat row. [本地改造 2026-08-16 / 0.1.5 已迁移]

import { memo } from 'react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { VoiceCard } from './VoiceCard.tsx'
import css from './MessageItem.module.css'

/** Assistant voice-reply keyed Chat renderer: one standalone voice bar. */
export const VoiceReplyNodeView = memo(function VoiceReplyNodeView({
  node, loadVoice, t,
}: ChatNodeViewProps<'voice-reply'>) {
  const { voice } = node.data
  return (
    // data-voice-id: stable id for plugin auto-play "already played" persistence.
    <div className={css.voiceReplyRow} data-voice-reply data-voice-id={voice.voiceId}>
      <VoiceCard attachment={voice} load={loadVoice} t={t} />
    </div>
  )
})
