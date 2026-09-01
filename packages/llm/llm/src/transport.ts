/**
 * Transport-layer hardening for LLM provider requests (2026-08-27).
 *
 * Problem (from gw provider postmortem 2026-08-26/27): a Cloudflare-fronted
 * gateway showed intermittent `Connection error` / `TRANSPORT` failures that
 * never reached the gateway (local instant failures ~90ms, 0 tokens, no
 * server-side trace). Root cause is in the path between this Windows host and
 * the gateway: DNS, TUN/proxy, TLS, TCP reset, or a poisoned keep-alive pool.
 *
 * This module installs a resilient global `fetch` once per process:
 * - Every request goes through one replaceable undici `Agent` (created once,
 *   not per request) with explicit connect/headers timeouts and keep-alive
 *   bounds, matching upstream guidance.
 * - Pre-response transport failures classified as connection-reset codes
 *   destroy the current Agent and create a fresh one on the next request, so
 *   a poisoned keep-alive socket cannot be reused.
 * - Each transport failure's cause chain is captured into a bounded time
 *   window keyed by host, so SDK layers that flatten the error (pi-ai keeps
 *   only `error.message`) can still surface `ECONNRESET` / `ENOTFOUND` /
 *   `ETIMEDOUT` and friends in `llm/retry.failure.details`.
 *
 * Security boundary: this module records only whitelisted own fields
 * (code/errno/syscall/hostname/address/port + message), never headers, API
 * keys, URLs with query params, request bodies, or user prompts.
 *
 * @module @deepseek-ai/dsh-llm/transport
 */

import { Agent, fetch as undiciFetch } from 'undici'
import { transportErrorDetails } from './error-details.ts'

/** Connect timeout for the pooled Agent, per upstream guidance (ms). */
const CONNECT_TIMEOUT_MS = 10_000
/**
 * Max time waiting for response headers before the request is aborted (ms).
 * [2026-09-01] 30s → 13min：本机全局 fetch 也承载本地 TTS（audio8 :18795 克隆声
 * CPU 推理，长文本可达数分钟才回响应头），30s 会把正常慢请求错杀。LLM 网关的
 * 真死连接由 agent loop 自身的 signal 超时兜底，不靠这个传输层守卫。
 */
const HEADERS_TIMEOUT_MS = 780_000
/** Disable the response-body inactivity cutoff (the loop owns idle timeouts). */
const BODY_TIMEOUT_MS = 0
/** Idle keep-alive lifetime (ms); expired sockets close. */
const KEEP_ALIVE_TIMEOUT_MS = 10_000
/** Absolute socket reuse cap (ms), matching upstream guidance. */
const KEEP_ALIVE_MAX_TIMEOUT_MS = 30_000

/** Error codes that indicate a broken connection/socket; the pool must be rebuilt. */
export const CONNECTION_RESET_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ETIMEDOUT',
  'EAI_AGAIN',
])

/** How long a captured transport error stays usable by the flattening SDK layer (ms). */
const CAPTURE_WINDOW_MS = 60_000

/** Transport-error capture for SDKs that flatten the original cause away. */
interface TransportCapture {
  readonly host: string
  readonly time: number
  readonly details: Record<string, unknown>
}

let currentAgent: Agent | undefined
let globalFetchInstalled = false
const captures: TransportCapture[] = []

function hostOf(input: RequestInfo | URL): string {
  try {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url)
    return url.hostname
  } catch {
    return ''
  }
}

function createAgent(): Agent {
  return new Agent({
    connect: { timeout: CONNECT_TIMEOUT_MS },
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
  })
}

/** Lazily create the process-wide Agent; every call returns the live singleton. */
export function ensureDispatcher(): Agent {
  if (currentAgent === undefined) {
    currentAgent = createAgent()
  }
  return currentAgent
}

/** Destroy the current Agent (closing its pooled sockets) and recreate on demand. */
export function resetDispatcher(): void {
  const old = currentAgent
  currentAgent = undefined
  ensureDispatcher()
  void old?.close?.().catch(() => undefined)
}

/** Walk the cause chain and report whether any link is a connection-reset code. */
export function shouldResetConnection(error: unknown): boolean {
  let current: unknown = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 4 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current)
    const code = (current as Error & { code?: unknown }).code
    if (typeof code === 'string' && CONNECTION_RESET_CODES.has(code)) return true
    current = (current as Error & { cause?: unknown }).cause
  }
  return false
}

/** Retain one transport capture, pruning entries older than the window. */
function capture(input: RequestInfo | URL, error: unknown): void {
  const now = Date.now()
  const host = hostOf(input)
  captures.push({ host, time: now, details: transportErrorDetails(error) })
  for (;;) {
    const first = captures[0]
    if (first === undefined || now - first.time <= CAPTURE_WINDOW_MS) break
    captures.shift()
  }
}

/**
 * Latest transport failure detail captured within the window, optionally
 * restricted to one host. Returns `undefined` when nothing fresh is available.
 */
export function latestTransportErrorDetails(host?: string): Record<string, unknown> | undefined {
  const now = Date.now()
  for (let i = captures.length - 1; i >= 0; i -= 1) {
    const entry = captures[i] as TransportCapture
    if (now - entry.time > CAPTURE_WINDOW_MS) continue
    if (host !== undefined && entry.host !== host) continue
    return entry.details
  }
  return undefined
}

/**
 * Install the resilient global `fetch` (idempotent; safe to call from every
 * adapter). Replaces `globalThis.fetch` with an undici-backed wrapper that
 * uses the replaceable Agent, captures transport failures, and rebuilds the
 * socket pool on connection-reset codes. SDKs using the ambient `fetch`
 * (pi-ai, llm-deepseek) inherit all three behaviors transparently.
 */
export function installResilientFetch(): void {
  if (globalFetchInstalled) return
  globalFetchInstalled = true
  // undici 7 的 fetch 签名与全局 fetch 存在 ReadableStream 泛型差异，统一按
  // 全局 fetch 的签名使用（运行时同一实现）。
  const undiciFetchCompat = undiciFetch as unknown as typeof globalThis.fetch
  const resilientFetch: typeof globalThis.fetch = (input, init) => {
    const signal = init?.signal
    // dispatcher 是 undici 的扩展字段（全局 fetch 类型未声明，运行时同一实现）。
    const dispatcherInit = { ...init, dispatcher: ensureDispatcher() } as RequestInit & { dispatcher: unknown }
    const result = undiciFetchCompat(input, dispatcherInit)
    const observe = (error: unknown): void => {
      // [2026-09-01 根治 fatal] 此观察链只做捕获，绝不 rethrow：`.then(undefined, observe)`
      // 会派生出一个新 promise，观察器一旦 rethrow，该派生 promise 被拒绝且无人
      // 接（`void` 不算处理）→ unhandledRejection → app-boot installFailLoud 直接
      // 杀进程。真实失败仍经下方原样 return 的 `result` 交给调用方处理。
      if (signal?.aborted === true) return
      if (shouldResetConnection(error)) resetDispatcher()
      capture(input, error)
    }
    // Capture failures for both stages of the returned promise chain.
    void result.then(undefined, observe)
    return result
  }
  globalThis.fetch = resilientFetch
}

/** Test-only access to the live singleton identity (null when never created). */
export function _currentDispatcherForTest(): Agent | undefined {
  return currentAgent
}
