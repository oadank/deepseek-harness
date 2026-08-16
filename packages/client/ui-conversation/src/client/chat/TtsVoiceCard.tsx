// TtsVoiceCard: locally synthesized reply audio (voice-iron-rule reply). The
// bytes come back inline from voice.tts and play straight from an object URL —
// nothing is stored in the session log, so the card is pure presentation.

import { useEffect, useRef, useState } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './TtsVoiceCard.module.css'

/** Decode a base64 payload into a browser Blob URL. */
function audioUrlOf(mediaType: string, data: string): string {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return URL.createObjectURL(new Blob([bytes.buffer], { type: mediaType }))
}

/** Synthesized voice reply pill: play/pause + estimated duration. */
export function TtsVoiceCard({ mediaType, data, durationMs, t }: {
  mediaType: string
  data: string
  durationMs?: number
  t: ChatViewSlotProps['t']
}) {
  const [url] = useState(() => audioUrlOf(mediaType, data))
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => { URL.revokeObjectURL(url) }, [url])
  const toggle = (): void => {
    const audio = audioRef.current
    if (audio === null) return
    if (playing) audio.pause()
    else void audio.play().catch(() => { setPlaying(false) })
  }
  const seconds = durationMs === undefined ? null : Math.max(1, Math.ceil(durationMs / 1_000))
  return (
    <div className={css.card} data-tts-voice>
      <button
        type="button"
        className={css.play}
        aria-label={playing ? t('voice.pause') : t('voice.play')}
        onClick={toggle}
      >
        {playing
          ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <rect x="3.5" y="3.5" width="3" height="9" rx="1" fill="currentColor"/>
              <rect x="9.5" y="3.5" width="3" height="9" rx="1" fill="currentColor"/>
            </svg>
          )
          : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M5 3.5L12.5 8L5 12.5V3.5Z" fill="currentColor"/>
            </svg>
          )}
      </button>
      <span className={css.duration}>{seconds === null ? '' : `${seconds}s`}</span>
      <span className={css.label}>{t('voice.reply')}</span>
      <audio
        ref={audioRef}
        src={url}
        onPlay={() => { setPlaying(true) }}
        onPause={() => { setPlaying(false) }}
        onEnded={() => { setPlaying(false) }}
      />
    </div>
  )
}
