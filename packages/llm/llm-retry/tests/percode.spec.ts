import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { BackoffConfig, NormalRetryPolicyConfig, PerCodeRetryConfig, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '../src/index.ts'

/**
 * 2026-08-27 传输诊断测试：
 * 1) TRANSPORT 的 per-code 重试策略独立生效（8 次 / 长退避窗口），429/5xx 走
 *    策略级参数——gw 老板要求的"不要混合同一策略"。
 * 2) LlmError 的 cause 链细节进入 llm/retry.failure.details（ECONNRESET 等），
 *    且不携带请求正文/API key。
 */

type ScriptEntry = Error | Iterable<import('@deepseek-ai/dsh-llm').StreamChunk>

class ScriptedAdapter extends (await import('@deepseek-ai/dsh-llm')).LlmAdapter {
  readonly requests: unknown[] = []
  private policies: Record<string, ReturnType<typeof resolveRetryPolicy> | undefined> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  configure(policies: Readonly<Record<string, RetryPolicyConfig | undefined>>): void {
    this.policies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined ? undefined : resolveRetryPolicy(policy, `percode test "${provider}"`),
    ]))
  }

  override providerRetryPolicy(provider: string): ReturnType<typeof resolveRetryPolicy> | undefined {
    return this.policies[provider]
  }

  async * stream(options: unknown): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('percode test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }
}

function textResponse(text: string): import('@deepseek-ai/dsh-llm').StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** TRANSPORT 失败，带 cause（模拟 undici SocketError 链）。 */
function transportError(code = 'ECONNRESET'): LlmError {
  const cause = Object.assign(new Error('other side closed'), { code, errno: -104, syscall: 'read' })
  return new LlmError('Connection error.', 'TRANSPORT', { cause })
}

async function harness(adapter: ScriptedAdapter, policy: RetryPolicyConfig): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  adapter.configure({ mock: policy })
  await ctx.plugin(Object.assign((inner: Context) => retry.apply(inner, {}, { random: () => 0.5 }), { inject: retry.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function normalConfig(overrides: Record<string, unknown> = {}): RetryPolicyConfig {
  const { backoff, codes, ...rest } = overrides as {
    backoff?: BackoffConfig
    codes?: Record<string, PerCodeRetryConfig>
    maxRetries?: number
  }
  const base: NormalRetryPolicyConfig = {
    mode: 'normal',
    maxRetries: 5,
    ...rest,
    backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0, ...backoff },
  }
  return codes === undefined ? base : { ...base, codes }
}

let context: Context | undefined
afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

describe('per-code TRANSPORT retry policy', () => {
  it('uses the TRANSPORT-specific budget (8) and never beyond it', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 8 }, () => transportError()),
      textResponse('recovered'),
    ])
    const policy = normalConfig({
      codes: { TRANSPORT: { maxRetries: 8, backoff: { initialDelayMs: 500, maxDelayMs: 15_000, jitterRatio: 0.1 } } },
    })
    context = await harness(adapter, policy)

    const agent = context.agentLoop.create(SessionId('percode-8'), {
      provider: 'mock', model: 'mock',
    })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await vi.advanceTimersByTimeAsync(70_000)
    await idle

    expect(adapter.requests).toHaveLength(9)
    const retries = agent.session.events.filter(e => e.type === 'llm/retry')
    expect(retries).toHaveLength(8)
    for (const r of retries) {
      // TRANSPORT per-code 走 normal 分支，maxRetries 在该联合分支上
      expect('maxRetries' in r.data ? r.data.maxRetries : 0).toBe(8)
      expect(r.data.failure.code).toBe('TRANSPORT')
    }
  }, 20_000)

  it('captures the underlying cause chain (ECONNRESET) in failure.details', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      transportError('ECONNRESET'),
      textResponse('recovered'),
    ])
    const policy = normalConfig({ codes: { TRANSPORT: { maxRetries: 2 } } })
    context = await harness(adapter, policy)

    const agent = context.agentLoop.create(SessionId('percode-details'), {
      provider: 'mock', model: 'mock',
    })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await vi.advanceTimersByTimeAsync(5_000)
    await idle

    const retry = agent.session.events.find(e => e.type === 'llm/retry')
    expect(retry).toBeDefined()
    if (retry === undefined) throw new Error('expected an llm/retry event')
    const details = retry.data.failure.details as Record<string, unknown> | undefined
    expect(details).toBeDefined()
    if (details === undefined) throw new Error('expected failure.details')
    // LlmError 的 details 从构造时的 cause 链提取：第一层即底层 undici 错误
    expect(details.code).toBe('ECONNRESET')
    expect(details.syscall).toBe('read')
    // 安全边界：没有任何 key/正文/提示词泄漏进 details 或失败信息
    expect(JSON.stringify(retry.data)).not.toMatch(/authorization|Bearer|api[_-]?key/i)
    expect(details.body).toBeUndefined()
  })

  it('keeps HTTP 429 on the policy-level budget when TRANSPORT has its own', async () => {
    vi.useFakeTimers()
    // TRANSPORT 预算 8 次；429 用策略级 5 次 → 429 连败 6 次后放弃（不借 TRANSPORT 的预算）
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 6 }, () => new LlmError('busy', 'RATE_LIMIT', { status: 429 })),
    ])
    const policy = normalConfig({
      codes: { TRANSPORT: { maxRetries: 8, backoff: { initialDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 } } },
      backoff: { initialDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
      maxRetries: 5,
    })
    context = await harness(adapter, policy)

    const agent = context.agentLoop.create(SessionId('percode-429'), {
      provider: 'mock', model: 'mock',
    })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await vi.advanceTimersByTimeAsync(5_000)
    await idle

    // 6 次请求：1 次原始 + 5 次重试（429 预算 5，不借 TRANSPORT 的 8）
    expect(adapter.requests).toHaveLength(6)
    const retries = agent.session.events.filter(e => e.type === 'llm/retry')
    expect(retries).toHaveLength(5)
    const end = agent.session.events.at(-1)
    expect(end?.type === 'turn/end' && end.data.reason.kind === 'error').toBe(true)
  })
})
