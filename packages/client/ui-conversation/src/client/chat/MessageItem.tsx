// MessageItem: simple chat nodes — user and consumed-steering bubbles
// (right-aligned, with clock + copy IconActions; branch lives only under
// assistant answers), pending steering (copy only), context injection,
// compaction marker, retry disclosure, and unknown-surface JSON rows.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ModelRetryNode, TurnErrorNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { VoiceAttachmentRef } from '@deepseek-ai/dsh-client-connection/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { JsonBlock, MessageText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import { ReferenceIcon } from '../reference/ReferenceIcon.tsx'
import { CompactionItem } from './CompactionItem.tsx'
import { ContextInjectionRow } from './ContextInjectionRow.tsx'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './MessageItem.module.css'

type UserImage = Extract<UserMessageNode['content'][number], { type: 'image' }>
type UserVoice = Extract<UserMessageNode['content'][number], { type: 'voice' }>

// [本地改造 2026-08-18] 微信式语音互斥：同一时刻只播一条语音。点新的自动停旧的，
// 避免多个 <audio> 同时发声混在一起。模块级单例，跨卡片共享。
let activeVoice: { id: string; audio: HTMLAudioElement; setPlaying: (playing: boolean) => void } | null = null

function playExclusive(id: string, audio: HTMLAudioElement, setPlaying: (playing: boolean) => void): void {
  if (activeVoice !== null && activeVoice.id !== id) {
    activeVoice.audio.pause()
    activeVoice.setPlaying(false)
  }
  activeVoice = { id, audio, setPlaying }
  setPlaying(true)
}

// [本地改造 2026-08-18] 录音互斥：InputBar 开始录音时调用，停掉正在播放的语音，
// 避免外放声音被麦克风录进新语音（回声）。
export function stopVoicePlayback(): void {
  if (activeVoice !== null) {
    activeVoice.audio.pause()
    activeVoice.setPlaying(false)
    activeVoice = null
  }
}

function contentParts(content: readonly unknown[]): {
  text: string
  images: { attachment: UserImage['attachment'] }[]
  voices: { attachment: UserVoice['attachment'] }[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: { attachment: UserImage['attachment'] }[] = []
  const voices: { attachment: UserVoice['attachment'] }[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string; attachment?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    else if (b.type === 'image' && b.attachment !== undefined) {
      images.push({ attachment: (b as UserImage).attachment })
    }
    else if (b.type === 'voice' && b.attachment !== undefined) {
      voices.push({ attachment: (b as UserVoice).attachment })
    }
    else rest.push(block)
  }
  return { text: texts.join(''), images, voices, rest }
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1_000))
}

interface RetryCountdown {
  deadline: number
  seconds: number
}

function ModelRetryItem({ node, active, t }: {
  node: ModelRetryNode
  active: boolean
  t: ChatViewSlotProps['t']
}) {
  // Anchor the host-scheduled delay to this browser's first render of the
  // retry node. Host event time and Date.now() may belong to different clocks.
  const deadline = useMemo(() => Date.now() + node.delayMs, [node.delayMs, node.seq])
  const scheduledSeconds = retrySeconds(node.delayMs)
  const maximum = node.mode === 'normal' ? node.maxRetries : '∞'
  const [countdown, setCountdown] = useState<RetryCountdown>(() => ({
    deadline,
    seconds: retrySeconds(deadline - Date.now()),
  }))
  const remainingSeconds = countdown.deadline === deadline
    ? countdown.seconds
    : retrySeconds(deadline - Date.now())

  useEffect(() => {
    if (!active) return
    const updateCountdown = (): number => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => (
        current.deadline === deadline && current.seconds === next
          ? current
          : { deadline, seconds: next }
      ))
      return next
    }
    if (updateCountdown() === 1) return
    const timer = window.setInterval(() => {
      if (updateCountdown() === 1) window.clearInterval(timer)
    }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])

  const label = active
    ? t('message.retry.active')
    : node.retryState === 'cancelled'
      ? t('message.retry.cancelled')
      : node.retryState === 'started'
        ? t('message.retry.started')
        : t('message.retry.scheduled')
  const seconds = active ? remainingSeconds : scheduledSeconds

  return (
    <details className={css.retryRow} data-active={active || undefined}>
      <summary className={css.retrySummary}>
        <span className={css.retryText} role="status">
          {t('message.retry.status', { label, retry: node.retry, maximum, seconds })}
        </span>
      </summary>
      <div className={css.retryDetails}>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.delay')}</span>
          {Math.round(node.delayMs)}ms
        </div>
        <div>
          <span className={css.retryDetailLabel}>{t('message.retry.failure')}</span>
          {node.failure.message}
        </div>
      </div>
    </details>
  )
}

/** Persistent, turn-positioned feedback for a terminal failure. */
function TurnErrorItem({ node, t }: {
  node: TurnErrorNode
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="error" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.turnErrorTitle}>{t('message.turnError')}</span>
        <span className={css.turnErrorMessage}>{node.message}</span>
      </div>
      {node.code !== undefined && <code className={css.turnErrorCode}>{node.code}</code>}
    </div>
  )
}

/** Persistent, turn-positioned notice for a turn ended at the output-token cap. */
function TurnMaxTokensItem({ t }: {
  t: ChatViewSlotProps['t']
}) {
  return (
    <div className={css.turnErrorRow} role="status">
      <StateDot state="warning" className={css.turnErrorDot} />
      <div className={css.turnErrorCopy}>
        <span className={css.maxTokensTitle}>{t('message.maxTokens')}</span>
        <span className={css.turnErrorMessage}>{t('message.maxTokens.hint')}</span>
      </div>
    </div>
  )
}

/**
 * Display projection of reference forms in a user bubble (free geometry — no
 * textarea alignment constraint here); everything else stays plain text. The
 * logged model text remains the single truth; this is presentation only.
 * Plain-text `/name` / `@name` word-boundary tokens decorate (the sent text
 * IS the reference — the bubble uses the same plainest token
 * scan as the composer, minus the lexicon: sent tokens were validated at
 * compose time, so shape alone decorates).
 */
function projectUserText(text: string, sessionLabels: readonly string[]): ReactNode {
  const ranges: { start: number; end: number; label: string; kind: 'session' | 'plain' }[] = []
  for (const rawLabel of [...new Set(sessionLabels)].sort((a, b) => b.length - a.length)) {
    const label = `@${rawLabel}`
    let start = text.indexOf(label)
    while (start >= 0) {
      ranges.push({ start, end: start + label.length, label, kind: 'session' })
      start = text.indexOf(label, start + label.length)
    }
  }
  const re = /(^|\s)(\/[\w-]+|@"[^"\n]+"|@[^\s]+)/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tokenStart = m.index + (m[1]?.length ?? 0)
    const rawLabel = m[2] ?? ''
    const label = rawLabel.startsWith('@"')
      ? rawLabel
      : rawLabel.replace(/[.,;:!?，。；：！？]+$/gu, '')
    if (label.length <= 1) continue
    ranges.push({ start: tokenStart, end: tokenStart + label.length, label, kind: 'plain' })
  }
  ranges.sort((a, b) => a.start - b.start
    || (a.kind === b.kind ? b.end - a.end : a.kind === 'session' ? -1 : 1))
  const parts: ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start < cursor) continue
    const { start: tokenStart, end, label, kind } = range
    if (tokenStart > cursor) parts.push(<MessageText key={cursor} text={text.slice(cursor, tokenStart)} />)
    const referenceKind = kind === 'session'
      ? 'session'
      : label.startsWith('@')
        ? label.endsWith('/') ? 'folder' : 'file'
        : undefined
    const displayLabel = referenceKind === undefined
      ? label
      : referenceKind === 'session'
        ? label.slice(1)
        : label.slice(1).replace(/^"|"$/gu, '').split(/[\\/]/u).filter(Boolean).at(-1) ?? label.slice(1)
    parts.push(
      <span
        key={tokenStart}
        className={css.refChip}
        data-ref-chip={referenceKind ?? 'skill'}
        title={label}
      >
        {referenceKind !== undefined && (
          <ReferenceIcon kind={referenceKind} size={16} className={css.refIcon} />
        )}
        {displayLabel}
      </span>,
    )
    cursor = end
  }
  if (parts.length === 0) return <MessageText text={text} />
  if (cursor < text.length) parts.push(<MessageText key={cursor} text={text.slice(cursor)} />)
  return <>{parts}</>
}

/** [本地改造 2026-08-16] 语音条宽度：4 秒内固定 96px（短语音不显拥挤），超过后每增 1 秒 +4px，上限 320px。 */
function voiceCardWidth(seconds: number): number {
  if (seconds <= 4) return 96
  return Math.min(320, 96 + (seconds - 4) * 4)
}

/** Right-aligned voice message card: session-authorized playback with duration. */
export function VoiceCard({ attachment, load, actions, asrFailedHint = false, t }: {
  attachment: VoiceAttachmentRef
  load?: (ref: VoiceAttachmentRef) => Promise<string>
  /** [本地改造 2026-08-21] Voice-actions slot strip rendered at the card tail. */
  actions?: ReactNode
  /** [本地改造 2026-08-21] 无转写时是否显示「未能识别」提示：仅用户语音消息
   *  开启；助手 TTS 语音回复没有 transcript 概念，不显示。 */
  asrFailedHint?: boolean
  t: ChatViewSlotProps['t']
}) {  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [copied, setCopied] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    setUrl(null)
    // A missing loader (deployment without the voice channel) degrades to the
    // disabled card rather than crashing the whole message row.
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
  // [本地改造 2026-08-16] 语音条宽度按时长变化（微信风格）：8 秒以内固定宽度
  // （短语音不显拥挤），超过 8 秒按秒数线性增宽，上限 320px；
  // 带 transcript 的用户语音由文本自然撑宽（保持现状）。
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
      {/* [本地改造 2026-08-21] 语音条复制按钮：外部 voice-actions 优先（插件）；
          未提供（如 AI 语音回复）且有转写时，用内置按钮兜底，保证所有语音条可复制。 */}
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
                  window.setTimeout(() => setCopied(false), 1000)
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
}

/** Right-aligned bubble shared by user and steering rows. */
function UserStyleBubble({
  content,
  renderMessageImages,
  voiceLoader,
  actions,
  renderVoiceActions,
  voiceAsrFailedHint = false,
  pending = false,
  referenceLabels = [],
  t,
}: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  voiceLoader: (ref: VoiceAttachmentRef) => Promise<string>
  /** Optional IconActions (or similar) below the bubble; receives the joined text. */
  actions?: (text: string) => ReactNode
  /** [本地改造 2026-08-21] Voice-actions slot strip, resolved per voice card. */
  renderVoiceActions?: (attachment: VoiceAttachmentRef, index: number) => ReactNode
  /** [本地改造 2026-08-21] 语音无转写时显示「未能识别」提示（用户消息才开）。 */
  voiceAsrFailedHint?: boolean
  /** Whether this is the Host-authoritative pre-admission steering projection. */
  pending?: boolean
  /** Exact session mention labels associated by the adjacent recall node. */
  referenceLabels?: readonly string[]
  t: ChatViewSlotProps['t']
}): ReactNode {
  const { text, images, voices, rest } = contentParts(content)
  // [本地改造 2026-08-21] 语音消息复制：把每条语音的转写文本并入复制文本。
  // 纯语音消息本身没有 text 段，转写只挂在 attachment.transcript 上，否则复制按钮
  // 写出的 text 为空，粘贴是空白。有文字时文本在前、转写按语音顺序追加在后。
  const voiceTranscripts = voices
    .map(v => v.attachment.transcript)
    .filter((s): s is string => typeof s === 'string' && s !== '')
  const copyText = [text, ...voiceTranscripts].join('\n').trim()
  const truncated = (total: number): string => t('json.truncated', { total })
  const showBubble = text !== '' || rest.length > 0
  return (
    <div className={css.userRow} data-pending-steering={pending || undefined} data-time-hover-root>
      <div className={css.userStack}>
        {renderMessageImages({ images, align: 'end' })}
        {voices.map((voice, i) => (
          <VoiceCard
            key={i}
            attachment={voice.attachment}
            load={voiceLoader}
            actions={renderVoiceActions?.(voice.attachment, i)}
            asrFailedHint={voiceAsrFailedHint}
            t={t}
          />
        ))}
        {showBubble && <div className={css.bubble}>
          {projectUserText(text, referenceLabels)}
          {rest.map((block, i) => <JsonBlock key={i} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />)}
        </div>}
        {referenceLabels.length > 0 && (
          <div className={css.referenceSummary}>
            {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
          </div>
        )}
      </div>
      {actions?.(copyText)}
    </div>
  )
}

/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
export function PendingSteeringBubble({ content, renderMessageImages, loadVoice, t }: {
  content: readonly unknown[]
  renderMessageImages: ChatNodeOwnerProps['renderMessageImages']
  loadVoice?: (ref: VoiceAttachmentRef) => Promise<string>
  t: ChatViewSlotProps['t']
}): ReactNode {
  const voiceLoader = loadVoice ?? (() => Promise.reject(new Error(t('voice.loadFailed'))))
  return (
    <UserStyleBubble
      content={content}
      renderMessageImages={renderMessageImages}
      voiceLoader={voiceLoader}
      pending
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          clock="start"
          className={css.actions}
          t={t}
        />
      )}
    />
  )
}

/** User and admitted-steering keyed Chat renderer. */
export type UserMessageNodeViewProps = ChatNodeViewProps<'user' | 'steering'>
  & PropsRenderSlots<'conversation.chat.user-actions' | 'conversation.chat.voice-actions'>

export const UserMessageNodeView = memo(function UserMessageNodeView({
  node, renderMessageImages, loadVoice, renderSlot, t,
}: UserMessageNodeViewProps) {
  const data = node.data
  // [本地改造 2026-08-21] 用户消息操作行：语音转写只挂在 attachment.transcript 上、
  // 不在 text 段，把转写文本作为 owner currency 交给 user-actions 槽
  // （供「复制转写」类按钮直接使用，无需再按 id 回溯消息）。
  const voiceTranscripts = data.content
    .filter((b): b is UserVoice => b.type === 'voice')
    .map(b => b.attachment.transcript)
    .filter((s): s is string => typeof s === 'string' && s !== '')
  const userActions = renderSlot('conversation.chat.user-actions', { seq: data.seq, voiceTranscripts })
  // [本地改造 2026-08-21] 语音条尾部动作：逐条语音卡解析，给「复制转写」按钮
  // 放在语音条最后面（卡片内、转写文本之后），而不是消息操作行里。
  const renderVoiceActions = (attachment: VoiceAttachmentRef, index: number): ReactNode =>
    renderSlot('conversation.chat.voice-actions', {
      seq: data.seq,
      index,
      transcript: attachment.transcript ?? '',
    })
  return (
    <UserStyleBubble
      content={data.content}
      renderMessageImages={renderMessageImages}
      voiceLoader={loadVoice}
      renderVoiceActions={renderVoiceActions}
      voiceAsrFailedHint
      {...data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels }}
      t={t}
      actions={text => (
        <MessageIconActions
          text={text}
          time={data.time}
          clock="start"
          className={css.actions}
          extraActions={userActions}
          t={t}
        />
      )}
    />
  )
})

/** Injected-context keyed Chat renderer. */
export const ContextMessageNodeView = memo(function ContextMessageNodeView({ node, t }: ChatNodeViewProps<'context'>) {
  const data = node.data
  // [本地改造 2026-08-16] 隐藏 vision-qa 图片识别的注入行：识别在后台完成，用户无感知
  // （消息仍在会话日志、模型可见；用户只看到自己的图片消息与助手回复——正常图片交互）
  const src = data.source as { kind?: string; plugin?: string } | null
  if (src?.kind === 'plugin' && src.plugin === 'vision-qa') return null
  return (
    <ContextInjectionRow
      content={data.content}
      source={data.source}
      provenance={data.provenance}
      form={data.form}
      t={t}
    />
  )
})

/** Automatic compaction keyed Chat renderer. */
export const CompactionNodeView = memo(function CompactionNodeView({ node, t }: ChatNodeViewProps<'compaction'>) {
  return <CompactionItem node={node.data} t={t} />
})

/** Correlated retry-chain keyed Chat renderer. */
export const RetryNodeView = memo(function RetryNodeView({ node, t }: ChatNodeViewProps<'model-retry'>) {
  const data = node.data
  return <ModelRetryItem node={data.current} active={data.current.retryState === 'scheduled'} t={t} />
})

/** Terminal turn-error keyed Chat renderer. */
export const TurnErrorNodeView = memo(function TurnErrorNodeView({ node, t }: ChatNodeViewProps<'turn-error'>) {
  return <TurnErrorItem node={node.data} t={t} />
})

/** Max-tokens turn-end notice keyed Chat renderer. */
export const TurnMaxTokensNodeView = memo(function TurnMaxTokensNodeView({ t }: ChatNodeViewProps<'turn-max-tokens'>) {
  return <TurnMaxTokensItem t={t} />
})

/** Explicit unknown-surface keyed Chat renderer. */
export const UnknownNodeView = memo(function UnknownNodeView({ node, t }: ChatNodeViewProps<'unknown'>) {
  const data = node.data
  return (
    <div className={css.contextRow}>
      <JsonBlock
        label={t('message.unknownSurface', { type: data.type })}
        payload={data.data}
        truncatedLabel={total => t('json.truncated', { total })}
      />
    </div>
  )
})
