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
  // [本地改造 2026-09-22] 重取地址计数器：播放失败/音频流被切断后按钮要能自愈（见 toggle）。
  const [reloadKey, setReloadKey] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // [本地改造 2026-09-22 老大实测·新语音自动播放播两三秒就断] 依赖必须用稳定的 voiceId，
  // 不能用 attachment 对象本身：assistant 消息还在流式渲染时 Chat Node 会反复重建，每次都给出
  // 一个新的 attachment 引用 → 这个 effect 跟着重跑 → 下面的 setUrl(null) 把 audio.src 清掉 → 正在
  // 自动播放的新语音立刻断掉（旧语音消息已静止，所以手点能完整播完）。
  // voiceId 是内容寻址的 sha256，内容变了 id 就变，用 id 当依赖不会漏刷新。
  const attachmentRef = useRef(attachment)
  attachmentRef.current = attachment
  const voiceId = attachment.voiceId
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    if (load === undefined) {
      setFailed(true)
      return () => { cancelled = true }
    }
    load(attachmentRef.current).then((next) => {
      // 不清空旧 url：地址没变就保持原引用，避免正在播放的 audio 被换掉。
      if (!cancelled) setUrl(prev => (prev === next ? prev : next))
    }, () => {
      if (!cancelled) setFailed(true)
    })
    return () => { cancelled = true }
  }, [voiceId, load, reloadKey])
  const toggle = (): void => {
    const audio = audioRef.current
    // [本地改造 2026-09-22 老大实测"播放到一半停住、之后点不动"] 原来 play() 一失败就 setFailed(true)，
    // 而按钮写的是 disabled={failed} —— 音频流被切断或被录音互斥掐停过一次，这条语音就永远点不动了。
    // 现在：失败态依然可点，点一下重新取地址再来一次，不再把自己锁死。
    if (audio === null || failed || audio.error !== null) {
      if (activeVoice?.id === attachment.voiceId) activeVoice = null
      setFailed(false)
      setUrl(null)
      setReloadKey(k => k + 1)
      return
    }
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
