/**
 * Human-facing `/compact` command over the backend-independent compaction seam.
 * @module @deepseek-ai/dsh-command-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'command-compact'
export const inject = ['commands', 'compaction']

const USAGE = '用法：/compact（无参数）'

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown manual compaction error code: ${String(value)}`)
}
/* v8 ignore stop */

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error: ManualCompactionError): CommandResult {
  switch (error.code) {
    case 'busy':
      return {
        kind: 'error',
        text: '压缩暂不可用：当前进程正在进行压缩，或智能体未处于空闲状态。',
      }
    case 'cancelled':
      return { kind: 'error', text: '压缩已取消。' }
    case 'changed':
      return {
        kind: 'error',
        text: '待压缩的历史在替换前发生了变化。对话保持不变；该次尝试已记录在会话日志中。',
      }
    case 'summary':
      return {
        kind: 'error',
        text: '压缩未能生成有效摘要。对话保持不变；该次尝试已记录在会话日志中。',
      }
    case 'commit':
      return {
        kind: 'error',
        text: '压缩未能干净结束；部分会话历史可能已变化。重试前请检查当前会话状态。',
      }
    case 'persistence':
      return {
        kind: 'error',
        text: '压缩已完成，但会话未能保存。',
      }
    /* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */
    default: return assertNever(error.code)
  }
}

/** Execute one argument-free manual compaction request. */
async function executeCompact(
  ctx: Context,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: USAGE }
  }
  try {
    const result = await ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)
    if (result === null) return { kind: 'success', text: '暂无可以压缩的历史。' }
    return {
      kind: 'success',
      text: `已压缩 ${result.shadowedSeqs.length} 条历史（约 ${result.shadowedTokenCount} tokens）。`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    if (invocation.signal.aborted) return { kind: 'error', text: '压缩已取消。' }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  }
}

/**
 * Register `/compact` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the compaction seam.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeCompact(ctx, invocation)
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      name: 'compact',
      description: '压缩较早的对话历史',
      handler,
    })
  }, 'command-compact lifecycle')
}
