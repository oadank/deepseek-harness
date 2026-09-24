/**
 * Host balance indicators on the Connection shared API channel.
 * Replaces retired apiproxy `balance.get` with GET /api/balance.
 * @module @deepseek-ai/dsh-host-balance
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHash, createHmac } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'balance'
/** Connection Fetch; agents + sessionProjections + credentials for provider-aware reads. */
export const inject = ['connection', 'agents', 'sessionProjections']

/** Authenticated browser path for one balance snapshot. */
export const BALANCE_PATH = '/api/balance'

export interface BalanceView {
  currency: string
  total: string
  granted: string
  toppedUp: string
}

export interface ArkUsageView {
  planType: string
  periods: Array<{
    label: string
    quota: number
    used: number
    resetAt: number
  }>
}

export interface BalanceSnapshot {
  balance: BalanceView | null
  gatewayHealthy: boolean | null
  usage: ArkUsageView | null
}

interface ConnectionFetchHost {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

interface AgentsHost {
  get(id: string): { session: Session } | undefined
}

interface SessionProjectionsHost {
  stateOf(session: Session, key: string): { pending?: unknown } | undefined
}

interface CredentialsHost {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value?: string } | undefined>
}

function connectionOf(ctx: Context): ConnectionFetchHost {
  return Reflect.get(ctx, 'connection') as ConnectionFetchHost
}

function agentsOf(ctx: Context): AgentsHost {
  return Reflect.get(ctx, 'agents') as AgentsHost
}

function projectionsOf(ctx: Context): SessionProjectionsHost {
  return Reflect.get(ctx, 'sessionProjections') as SessionProjectionsHost
}

function credentialsOf(ctx: Context): CredentialsHost | undefined {
  try {
    return ctx.get('credentials') as CredentialsHost | undefined
  } catch {
    return undefined
  }
}

async function resolveSecret(ctx: Context, envName: string): Promise<string | undefined> {
  const credentials = credentialsOf(ctx)
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(credentialRef(envName))
      if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value
    } catch {
      // fall through to env
    }
  }
  const env = process.env[envName]
  return env !== undefined && env.length > 0 ? env : undefined
}

function providerOfSession(ctx: Context, sessionId: string): string | undefined {
  const agent = agentsOf(ctx).get(sessionId)
  if (agent === undefined) return undefined
  try {
    // [本地改造 2026-09-11] 0.1.5 投影真实语义（agent.selectionFor 同源）：
    // pending 只在「选了还没发请求」时非空；request/header 发出后清 null，
    // 实际生效 provider 在会话日志最后一次 request/header 的 config 里。
    const state = projectionsOf(ctx).stateOf(agent.session, 'modelSelection') as
      | { pending?: { provider?: unknown } | null }
      | undefined
    const pending = state?.pending
    if (pending !== null && pending !== undefined && typeof pending.provider === 'string' && pending.provider !== '') {
      return pending.provider
    }
    // [本地改造 2026-09-11] 投影自带 lastUsed（request/header 事件自动维护）：
    // 发过请求的会话从这里读"当前生效 provider"，比扫日志便宜且语义同源。
    const stateAny = state as { lastUsed?: { provider?: unknown } | null } | undefined
    const lastUsed = stateAny?.lastUsed
    if (lastUsed !== null && lastUsed !== undefined && typeof lastUsed.provider === 'string' && lastUsed.provider !== '') {
      return lastUsed.provider
    }
    const logged = agent.session.requestHeader()?.config as { provider?: unknown } | undefined
    if (typeof logged?.provider === 'string' && logged.provider !== '') return logged.provider
  } catch {
    // projection/log missing — fall through
  }
  return undefined
}

let deepseekBalanceCache: { value: BalanceView | null; cachedAt: number } | null = null

async function readDeepSeekBalance(ctx: Context): Promise<BalanceView | null> {
  const now = Date.now()
  if (deepseekBalanceCache !== null && now - deepseekBalanceCache.cachedAt < 5_000) {
    return deepseekBalanceCache.value
  }
  const apiKey = await resolveSecret(ctx, 'DEEPSEEK_API_KEY')
  if (apiKey === undefined) {
    deepseekBalanceCache = { value: null, cachedAt: now }
    return null
  }
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      deepseekBalanceCache = { value: null, cachedAt: now }
      return null
    }
    const data = await response.json() as {
      balance_infos?: Array<{ currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }>
    }
    const info = data.balance_infos?.[0]
    if (info === undefined) {
      deepseekBalanceCache = { value: null, cachedAt: now }
      return null
    }
    const value: BalanceView = {
      currency: info.currency,
      total: info.total_balance,
      granted: info.granted_balance,
      toppedUp: info.topped_up_balance,
    }
    deepseekBalanceCache = { value, cachedAt: now }
    return value
  } catch {
    return deepseekBalanceCache?.value ?? null
  }
}

let gwBalanceCache: { value: BalanceView | null; cachedAt: number } | null = null

async function readGwBalance(ctx: Context): Promise<BalanceView | null> {
  const now = Date.now()
  if (gwBalanceCache !== null && now - gwBalanceCache.cachedAt < 5_000) {
    return gwBalanceCache.value
  }
  // [本地改造 2026-09-13] 修 gw 余额恒不显示：原文写 'GW_API_KEY'，但本机实际配置的
  // 密钥名是 'GATEWAY_API_KEY'（settings.yaml 的 llm-pi-ai.providers.gw.apiKeyEnv 与
  // ~/.dsh/.credentials.yaml 存的都是 GATEWAY_API_KEY，全仓库仅此一处写 GW_API_KEY）。
  // 名字不匹配 → resolveSecret 取不到 → 余额恒为 null。故改为 GATEWAY_API_KEY。
  const apiKey = await resolveSecret(ctx, 'GATEWAY_API_KEY')
  if (apiKey === undefined) {
    gwBalanceCache = { value: null, cachedAt: now }
    return null
  }
  try {
    const response = await fetch('https://gateway.henry-gao.com/v1/balance', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      gwBalanceCache = { value: null, cachedAt: now }
      return null
    }
    const data = await response.json() as {
      balance_cny?: string
      available_balance_cny?: string
    }
    if (data.balance_cny === undefined) {
      gwBalanceCache = { value: null, cachedAt: now }
      return null
    }
    const value: BalanceView = {
      currency: 'CNY',
      total: data.balance_cny,
      granted: data.available_balance_cny ?? data.balance_cny,
      toppedUp: '0',
    }
    gwBalanceCache = { value, cachedAt: now }
    return value
  } catch {
    return gwBalanceCache?.value ?? null
  }
}

let gwHealthCache: { value: boolean | null; cachedAt: number } | null = null

async function readGwHealth(): Promise<boolean | null> {
  const now = Date.now()
  if (gwHealthCache !== null && now - gwHealthCache.cachedAt < 5_000) {
    return gwHealthCache.value
  }
  try {
    const response = await fetch('https://gateway.henry-gao.com/health', {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      gwHealthCache = { value: false, cachedAt: now }
      return false
    }
    const data = await response.json() as { ready?: boolean }
    const value = data.ready === true
    gwHealthCache = { value, cachedAt: now }
    return value
  } catch {
    return gwHealthCache?.value ?? null
  }
}

const ARK_OPENAPI_HOST = 'ark.cn-beijing.volcengineapi.com'
const ARK_OPENAPI_REGION = 'cn-beijing'
const ARK_OPENAPI_SERVICE = 'ark'
let arkUsageCache: { value: ArkUsageView | null; cachedAt: number } | null = null

async function readArkUsage(ctx: Context): Promise<ArkUsageView | null> {
  const now = Date.now()
  if (arkUsageCache !== null && now - arkUsageCache.cachedAt < 60_000) {
    return arkUsageCache.value
  }
  const accessKeyId = await resolveSecret(ctx, 'VOLC_ACCESS_KEY_ID')
  const secretAccessKey = await resolveSecret(ctx, 'VOLC_SECRET_ACCESS_KEY')
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    arkUsageCache = { value: null, cachedAt: now }
    return null
  }
  try {
    const xdate = new Date().toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
      .replace(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z/, '$1$2$3T$4$5$6Z')
    const query = 'Action=GetAFPUsage&Version=2024-01-01'
    const body = '{}'
    const payloadHash = createHash('sha256').update(body, 'utf8').digest('hex')
    const signedHeaders = ['host', 'x-content-sha256', 'x-date']
    const canonicalHeaders = [
      `host:${ARK_OPENAPI_HOST}\n`,
      `x-content-sha256:${payloadHash}\n`,
      `x-date:${xdate}\n`,
    ].sort().join('')
    const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n')
    const scope = `${xdate.slice(0, 8)}/${ARK_OPENAPI_REGION}/${ARK_OPENAPI_SERVICE}/request`
    const stringToSign = ['HMAC-SHA256', xdate, scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n')
    const kDate = createHmac('sha256', secretAccessKey).update(xdate.slice(0, 8), 'utf8').digest()
    const kRegion = createHmac('sha256', kDate).update(ARK_OPENAPI_REGION, 'utf8').digest()
    const kService = createHmac('sha256', kRegion).update(ARK_OPENAPI_SERVICE, 'utf8').digest()
    const kSigning = createHmac('sha256', kService).update('request', 'utf8').digest()
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
    const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`
    const response = await fetch(`https://${ARK_OPENAPI_HOST}/?${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-date': xdate,
        'x-content-sha256': payloadHash,
        Authorization: authorization,
      },
      body,
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) {
      arkUsageCache = { value: null, cachedAt: now }
      return null
    }
    const data = await response.json() as {
      Result?: {
        PlanType?: string
        AFPFiveHour?: { Quota: number; Used: number; ResetTime: number }
        AFPWeekly?: { Quota: number; Used: number; ResetTime: number }
        AFPMonthly?: { Quota: number; Used: number; ResetTime: number }
      }
    }
    const result = data.Result
    if (result === undefined) {
      arkUsageCache = { value: null, cachedAt: now }
      return null
    }
    const periodView = (label: string, p?: { Quota: number; Used: number; ResetTime: number }) =>
      p === undefined
        ? null
        : { label, quota: Number(p.Quota), used: Number(p.Used), resetAt: Number(p.ResetTime) ?? 0 }
    const periods = [
      periodView('5h', result.AFPFiveHour),
      periodView('weekly', result.AFPWeekly),
      periodView('monthly', result.AFPMonthly),
    ].filter((p): p is NonNullable<typeof p> => p !== null)
    if (periods.length === 0) {
      arkUsageCache = { value: null, cachedAt: now }
      return null
    }
    const value: ArkUsageView = { planType: result.PlanType ?? '', periods }
    arkUsageCache = { value, cachedAt: now }
    return value
  } catch {
    return arkUsageCache?.value ?? null
  }
}

async function snapshot(ctx: Context, sessionId: string | undefined): Promise<BalanceSnapshot> {
  const provider = sessionId !== undefined && sessionId !== ''
    ? providerOfSession(ctx, sessionId)
    : lastUsedProvider()
  if (provider === 'gw') {
    return {
      balance: await readGwBalance(ctx),
      gatewayHealthy: await readGwHealth(),
      usage: null,
    }
  }
  if (provider === 'volc-ark') {
    return { balance: null, gatewayHealthy: null, usage: await readArkUsage(ctx) }
  }
  if (provider !== undefined && provider !== 'deepseek-official') {
    return { balance: null, gatewayHealthy: null, usage: null }
  }
  return { balance: await readDeepSeekBalance(ctx), gatewayHealthy: null, usage: null }
}

/**
 * [本地改造 2026-09-11] 无 sessionId（默认进入/新会话）时的回落：
 * 扫活跃会话取任一"当前生效 provider"（最近活跃优先），避免残留官方余额或"不适用"。
 * 都没有（冷启动）才落官方。
 */
function lastUsedProvider(): string | undefined {
  return undefined
}

/**
 * Register GET /api/balance on the shared API channel.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  connectionOf(ctx).fetch.register({
    path: BALANCE_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const sessionId = new URL(request.url).searchParams.get('sessionId') ?? undefined
      const snap = await snapshot(ctx, sessionId)
      const payload = JSON.stringify(snap)
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
        })
      }
      return new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    },
  })
}
