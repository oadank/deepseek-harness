// VoiceCard: durable voice object playback for user voice messages and
// assistant voice replies. [本地改造 2026-08-18] WeChat-style exclusive play.

import { memo, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { VoiceAttachmentRef } from '../contract/chat-nodes.ts'
import css from './MessageItem.module.css'

// [本地改造 2026-08-18] 微信式语音互斥：同一时刻只播一条语音。
let activeVoice: { id: string; audio: HTMLAudioElement; setPlaying: (playing: boolean) => void } | null = null

function playExclusive(id: string, audio: HTMLAudioElement, setPlaying: (playing: boolean) => void): void {
  if (activeVoice !== null && activeVoice.id !== id) {
    activeVoice.audio.pause()
    activeVoice.setPlaying(false)
  }
  activeVoice = { id, audio, setPlaying }
  setPlaying(true)
}

/** Stop any currently playing voice (called when recording starts). */
export function stopVoicePlayback(): void {
  if (activeVoice !== null) {
    activeVoice.audio.pause()
    activeVoice.setPlaying(false)
    activeVoice = null
  }
}

/** [本地改造 2026-08-16] 语音条宽度：4 秒内固定 96px，超过后每增 1 秒 +4px，上限 320px。 */
function voiceCardWidth(seconds: number): number {
  if (seconds <= 4) return 96
  return Math.min(320, 96 + (seconds - 4) * 4)
}

/** Right-aligned voice message card: session-authorized playback with duration. */
export const VoiceCard = memo(function VoiceCard({ attachment, load, actions, asrFailedHint = false, t }: {
  attachment: VoiceAttachmentRef
  load?: ((ref: VoiceAttachmentRef) => Promise<string>) | undefined
  /** [本地改造 2026-08-21] Voice-actions slot strip at the card tail. */
  actions?: ReactNode
  /** Show "未能识别" when there is no transcript (user voice only). */
  asrFailedHint?: boolean
  t: ChatViewSlotProps['t']
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [copied, setCopied] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    setUrl(null)
    if (load === undefined) {
      setFailed(true)
      return () => { cancelled = true }
    }
    load(attachment).then((next) => {
      if (!cancelled) setUrl(next)
    }, () => {
      if (!cancelled) setFailed(true)
    })
    return () => { cancelled = true }
  }, [attachment, load])
  const toggle = (): void => {
    const audio = audioRef.current
    if (audio === null) return
    if (playing) {
      audio.pause()
      if (activeVoice?.id === attachment.voiceId) activeVoice = null
    } else {
      playExclusive(attachment.voiceId, audio, setPlaying)
      void audio.play().catch(() => { setFailed(true) })
    }
  }
  const seconds = attachment.durationMs !== undefined
    ? Math.max(1, Math.ceil(attachment.durationMs / 1_000))
    : null
  const hasTranscript = attachment.transcript !== undefined && attachment.transcript !== ''
  const durationWidth = !hasTranscript && attachment.durationMs !== undefined
    ? { width: voiceCardWidth(seconds ?? 1) }
    : undefined
  return (
    <div className={css.voiceCard} data-voice style={durationWidth}>
      <button
        type="button"
        className={css.voicePlay}
        aria-label={playing ? t('voice.pause') : t('voice.play')}
        disabled={failed}
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
      <span className={css.voiceDuration}>{seconds === null ? '' : `${seconds}s`}</span>
      {hasTranscript ? (
        <span className={css.voiceTranscript} title={t('voice.transcriptLabel')}>
          {attachment.transcript}
        </span>
      ) : asrFailedHint ? (
        <span className={css.voiceTranscriptFailed} title={t('voice.asrFailed')}>
          {t('voice.asrFailed')}
        </span>
      ) : null}
      {actions !== undefined
        ? actions
        : (hasTranscript
          ? (
            <button
              type="button"
              className={css.voiceCopy}
              aria-label={copied ? t('copied') : t('copy')}
              title={copied ? t('copied') : t('copy')}
              onClick={() => {
                const text = attachment.transcript ?? ''
                const done = (): void => {
                  setCopied(true)
                  globalThis.setTimeout(() => setCopied(false), 1000)
                }
                if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                  void navigator.clipboard.writeText(text).then(done, done)
                } else { done() }
              }}
            >
              {copied
                ? (
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                    <path d="M3.5 8.5L6.5 11.5L12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )
                : (
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                    <rect x="5.5" y="5.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3"/>
                    <path d="M10.5 5.5V4.5A1 1 0 0 0 9.5 3.5H5A1 1 0 0 0 4 4.5v4.5a1 1 0 0 0 1 1h1" fill="none" stroke="currentColor" strokeWidth="1.3"/>
                  </svg>
                )}
            </button>
          )
          : null)}
      {url !== null && (
        <audio
          ref={audioRef}
          src={url}
          onPlay={() => { setPlaying(true) }}
          onPause={() => { setPlaying(false) }}
          onEnded={() => { setPlaying(false) }}
        />
      )}
    </div>
  )
})
