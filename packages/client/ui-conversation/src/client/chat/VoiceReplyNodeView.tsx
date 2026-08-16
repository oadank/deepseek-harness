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
    <div className={css.voiceReplyRow} data-voice-reply>
      <VoiceCard attachment={voice} load={loadVoice} t={t} />
    </div>
  )
})
