/**
 * Automation-only Agent Client Protocol server over JSON-RPC stdio.
 *
 * The bridge exposes fresh harness sessions to trusted programmatic clients. It
 * carries prompt text, committed assistant text, cancellation, and one-shot
 * permission decisions; presentation and human-interaction features stay with
 * the harness's UI modules.
 *
 * @module @deepseek-ai/dsh-acp
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
// Side-effect type import: declaration-merges the approval waterfall answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import { acpPromptToText, promptHasUnsupportedContent, turnEndToStopReason } from './codec.ts'

export const name = 'acp'
/** The bridge creates and owns agents; every other concern is carried by the agent composition. */
export const inject = ['agents']

/**
 * The single continuable-subagent teardown the bridge needs. Declared
 * structurally so this package does not depend on the subagent seam for one
 * shutdown hook; an absent service means nothing continuable was materialized.
 */
interface ContinuableDrain {
  /**
   * Close admission below exact host-owned parents, then dispose only their
   * continuable descendants child-first.
   */
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Plugin config: the provider/model selection used for each ACP-created agent. */
export interface AcpConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model name for created agents. */
  model?: string
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

export const Config: Schema<AcpConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
})

/** Per-session protocol state. */
interface SessionRecord {
  agent: Agent
  /** Exact owned-agent disposer; resolves after registry, loop, and session teardown. */
  dispose: () => Promise<void>
  /** In-flight prompt and its captured turn number for exact settlement. */
  inflight: {
    resolve: (reason: StopReason) => void
    reject: (error: Error) => void
    messageId: string
    turn: number | undefined
    /** The correlated turn's ending, set at turn/end and settled at whole-agent idle. */
    endReason: TurnEndReason | undefined
  } | undefined
}

/**
 * Mount the automation-only ACP server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Initial provider/model selection and optional test transport.
 */
export function apply(ctx: Context, config: AcpConfig): void {
  // ACP handlers execute outside this plugin's injection scope, so capture the
  // injected service during apply rather than reading it lazily in a callback.
  const agents = ctx.agents
  const logger = ctx.logger
  const sessions = new Map<SessionId, SessionRecord>()
  let closed = false
  let conn: AgentSideConnection

  /** Return the bridge-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send a protocol update without letting a disconnected client fail an agent turn. */
  const notify = (notification: SessionNotification): void => {
    /* v8 ignore next 3 -- only a transport write failure reaches this guard. */
    void conn.sessionUpdate(notification).catch((error: unknown) => {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    })
  }

  const settlePrompt = (record: SessionRecord, reason: StopReason): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  const rejectFromError = (
    inflight: NonNullable<SessionRecord['inflight']>,
    reason: Extract<TurnEndReason, { kind: 'error' }>,
  ): void => {
    inflight.reject(internalError(`turn failed: ${reason.error.message}`))
  }

  // Emit only committed assistant text. Raw chunks, reasoning, tools, plans,
  // titles, and retry markers are presentation or trace data and stay off the
  // automation wire.
  //
  // [本地改造 2026-08-13] 为让飞书/IM 客户端能看到思考层与工具层，额外推送：
  //   assistant/chunk 的 reasoning-delta → agent_thought_chunk
  //   assistant/chunk 的 text-delta      → agent_message_chunk（流式，不再等整块）
  //   tool/call                          → tool_call（status:running + title）
  //   tool/result                        → tool_call_update（status:completed + rawOutput 摘要）
  // 这些是 ACP 标准 SessionUpdate 类型（见 @agentclientprotocol/sdk），客户端兼容。
  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      // 流式思考/正文增量：assistant/chunk → reasoning-delta / text-delta
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
          notify({
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: chunk.text },
            },
          })
        } else if (chunk.type === 'text-delta' && chunk.text.length > 0) {
          notify({
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunk.text },
            },
          })
        }
      }
      // 工具调用开始：tool/call → tool_call（status:running）
      if (event.type === 'tool/call') {
        let rawInput: unknown
        try {
          rawInput = JSON.parse(event.data.arguments)
        } catch {
          rawInput = event.data.arguments
        }
        notify({
          sessionId: record.agent.session.id,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: String(event.data.callId),
            title: event.data.name,
            status: 'in_progress',
            kind: 'execute',
            rawInput,
          },
        })
      }
      // 工具调用完成：tool/result → tool_call_update（status:completed + 输出摘要）
      if (event.type === 'tool/result') {
        const out = event.data.message
        const callId = (out as { toolCallId?: unknown }).toolCallId
        let rawOutput: unknown = ''
        try {
          const blocks = (out as { content?: Array<{ type?: string; text?: string }> }).content
          if (Array.isArray(blocks)) {
            rawOutput = blocks
              .filter(b => b?.type === 'text' && typeof b.text === 'string')
              .map(b => b.text)
              .join('\n')
              .slice(0, 2000)
          }
        } catch {
          rawOutput = ''
        }
        if (callId !== undefined) {
          notify({
            sessionId: record.agent.session.id,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: String(callId),
              status: 'completed',
              rawOutput,
            },
          })
        }
      }
      if (event.type === 'assistant/message') {
        // 透传 usage 到 _meta（ACP 标准扩展点），供 agents-to-im 侧展示 Cache/上下文/余额。
        // TokenUsage 字段直接映射，缺省补 0，避免下游 NaN。
        const usageMeta = (() => {
          const u = (event.data as { usage?: unknown }).usage as
            | { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
            | undefined
          if (u === undefined) return undefined
          return {
            usage: {
              inputTokens: u.inputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              cacheReadTokens: u.cacheReadTokens ?? 0,
              cacheWriteTokens: u.cacheWriteTokens ?? 0,
              reasoningTokens: u.reasoningTokens ?? 0,
            },
          }
        })()
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text.length > 0) {
            notify({
              sessionId: record.agent.session.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: block.text },
                ...(usageMeta === undefined ? {} : { _meta: usageMeta }),
              },
            })
          } else if (block.type === 'image') {
            notify({
              sessionId: record.agent.session.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: `[image attachment ${block.attachment.attachmentId}]`,
                },
              },
            })
          }
        }
      }
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        if (event.data.reason.kind === 'error') {
          // Model failures surface immediately as prompt errors; ordinary
          // endings wait for whole-agent idle below.
          record.inflight = undefined
          rejectFromError(inflight, event.data.reason)
        } else {
          inflight.endReason = event.data.reason
        }
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    inflight.reject(internalError(`turn failed: ${errorChain(error)}`))
  })

  // Permission requests are a machine policy channel for ACP clients such as
  // dsh-subagent-acp. The bridge offers one-shot choices only and never infers a
  // durable grant from an unknown client response.
  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    return conn.requestPermission({
      sessionId: record.agent.session.id,
      toolCall: { toolCallId: request.callId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    return {
      initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        // Single-version agent: the spec's "same version if supported, else
        // the latest supported" both resolve to this server's one version.
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
          agentCapabilities: {
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
        })
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve()
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        validateSessionParams(params)
        const sessionId = SessionId(randomUUID())
        // No preset composition: the ACP bundle keeps the model-facing rows in
        // the host plane, so this agent reads them from the global layer. A
        // deployment that configures a roster has to join one here first
        // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(config),
        })
        /* v8 ignore next 4 -- a real stdio close can race an in-flight create. */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        sessions.set(sessionId, {
          agent: handle.agent,
          dispose: () => handle.dispose(),
          inflight: undefined,
        })
        return { sessionId }
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (record.inflight !== undefined) {
          throw invalidParams('a prompt is already in flight for this session')
        }
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text and resource_link prompt content is supported')
        }
        const text = acpPromptToText(params.prompt)
        if (text.trim().length === 0) throw invalidParams('empty prompt')

        // Not driving a retired agent is this bridge's contract: an
        // agent-loop-only reload disposes the loop's agents while the bridge
        // record survives, so validate the record against the live registry
        // before sending — a disposed machine would accept the item silently.
        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
        const stopReason = await new Promise<StopReason>((resolve, reject) => {
          // Arm the slot before followup() so a listener-driven synchronous
          // turn cannot slip past correlation; a synchronous followup()
          // failure (invalid input) must free the slot again or the session
          // would reject every later prompt as already in flight.
          const inflight: NonNullable<SessionRecord['inflight']> = {
            resolve, reject, messageId: message.id, turn: undefined, endReason: undefined,
          }
          record.inflight = inflight
          try {
            record.agent.followup(message)
            // The machine's send() contains listener failures and accepts
            // any typed input; this guards a future synchronous throw so the
            // slot cannot wedge.
            /* v8 ignore start -- future-proofing guard, see above */
          } catch (error: unknown) {
            record.inflight = undefined
            const detail = error instanceof Error ? error.message : String(error)
            throw internalError(`prompt was not queued: ${detail}`)
          }
          /* v8 ignore stop */
          // Settlement waits for whole-agent idle: a correlated turn/end arms
          // `endReason`, while a turnless slot (admission discarded the
          // prompt) stays cancelled. Other producers may run further turns
          // before quiescence; the prompt settles only when the agent stops.
          void record.agent.whenIdle().then(() => {
            if (record.inflight !== inflight) return
            record.inflight = undefined
            const end = inflight.endReason
            if (end === undefined) {
              inflight.resolve('cancelled')
            } else {
              // Token-limit and other non-terminal endings are not prompt-level
              // stop reasons (see README); only normal quiescence reports end_turn.
              inflight.resolve(end.kind === 'max-tokens' ? 'end_turn' : turnEndToStopReason(end))
            }
          })
        })
        return { stopReason }
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        record.agent.cancel({ kind: 'user' })
        settlePrompt(record, 'cancelled')
        return Promise.resolve()
      },
    }
  }

  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const stream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, stream)

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    // Stop the bridge's own work before any await: a descendant drain can block
    // on persistence or scoped cleanup, and the top-level agents must not keep
    // running model and tool calls for its whole duration.
    for (const record of records) {
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
    }
    quiescing = (async () => {
      // Continuable subagents outlive the turn that started them, and their
      // Activations own descendant teardown. Drain only these sessions' forests
      // child-first BEFORE disposing the top-level agents, so no descendant is
      // left holding a runtime its owner already released and another frontend
      // sharing this Context remains live.
      // Read the one teardown method structurally: the bridge needs no other
      // part of the subagent seam, so it does not depend on that package.
      const subagents = ctx.get('subagents') as ContinuableDrain | undefined
      if (subagents !== undefined) {
        try {
          await subagents.drainContinuableDescendants(records.map(record => record.agent))
        } catch (error: unknown) {
          logger.warn(`acp: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      const disposals = await Promise.allSettled(records.map(record => record.dispose()))
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected') failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        // The production consumer logs this AggregateError through `String`,
        // which renders only its message. Embed every per-session diagnostic,
        // including nested causes and aggregate members, in that message.
        const detail = failures.map(failure => errorChain(failure)).join('; ')
        throw new AggregateError(
          failures,
          `ACP agent teardown failed for ${failures.length} session(s): ${detail}`,
        )
      }
    })()
    return quiescing
  }

  /* v8 ignore start -- production transport rejection and teardown failure. */
  void conn.closed
    .catch((error: unknown) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error: unknown) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })
  /* v8 ignore stop */

  ctx.effect(() => quiesce, 'acp.connection')
}

/**
 * Build per-agent options from plugin config without assigning absent optional fields.
 * @param config - ACP provider/model configuration.
 * @returns the configured fields only.
 */
function agentOptions(config: AcpConfig): { provider?: string; model?: string } {
  return {
    ...config.provider !== undefined ? { provider: config.provider } : {},
    ...config.model !== undefined ? { model: config.model } : {},
  }
}

/** Reject session features outside the automation contract. */
function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if (params.mcpServers.length > 0) throw invalidParams('mcpServers is not supported')
}
