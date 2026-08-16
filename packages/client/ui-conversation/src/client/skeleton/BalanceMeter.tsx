/** Composer balance indicator: `余额: ¥xx.xx` plain text beside the model seat,
 * fed by the host `balance.get` RPC (DeepSeek 直连账户余额). Renders nothing
 * until a balance is available (non-direct deployments return null) and
 * refreshes live: on every request completion (running → idle edge) plus a 30s
 * poll while visible, so the shown number tracks the real balance. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BalanceView } from '@deepseek-ai/dsh-client-connection/client'
import css from './BalanceMeter.module.css'

/** 可见余额指示的轮询间隔：host 缓存 5s，前端 30s 拉一次足够贴近实时。 */
const POLL_MS = 30_000

export interface BalanceMeterProps {
  /** Host balance query; undefined = no session (component hides). */
  readBalance: (() => Promise<{ balance: BalanceView | null }>) | undefined
  /** Whether the session is currently running a turn (refresh edge). */
  running: boolean
}

/**
 * Render the balance indicator.
 * @param props - the host query and the session running flag.
 * @returns the balance text while a balance is known; null otherwise.
 */
export function BalanceMeter({ readBalance, running }: BalanceMeterProps) {
  const [balance, setBalance] = useState<BalanceView | null>(null)
  const [visible, setVisible] = useState(false)
  const prevRunning = useRef(running)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (readBalance === undefined) return
    try {
      const { balance: next } = await readBalance()
      setBalance(next)
      setVisible(next !== null)
    } catch {
      // 查询失败保持当前显示（隐藏或旧值），绝不打扰输入。
    }
  }, [readBalance])

  // Initial load; then a live poll only while a balance is actually shown.
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first mount only
  }, [readBalance])
  useEffect(() => {
    if (visible && pollRef.current === null) {
      pollRef.current = setInterval(() => { void refresh() }, POLL_MS)
    }
    if (!visible && pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current)
    }
  }, [visible, refresh])
  // Request completion is the most meaningful moment to refresh: a turn just
  // spent balance, so show the post-request number immediately.
  useEffect(() => {
    if (prevRunning.current && !running) void refresh()
    prevRunning.current = running
  }, [running, refresh])

  if (!visible || balance === null) return null
  const label = `余额: ¥${balance.total}`
  const detail = `总额 ¥${balance.total} · 赠送 ¥${balance.granted} · 充值 ¥${balance.toppedUp}`
  return (
    <span className={css.root}>
      <Tooltip label={detail} side="top" delayMs={500}>
        <button
          type="button"
          className={css.trigger}
          aria-label={label}
          title={detail}
        >
          <span className={css.text}>{label}</span>
        </button>
      </Tooltip>
    </span>
  )
}
