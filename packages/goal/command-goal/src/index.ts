/**
 * Human-facing `/goal` command over the persisted same-session goal domain.
 * @module @deepseek-ai/dsh-command-goal
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { GoalError } from '@deepseek-ai/dsh-goal'
import type { GoalPhase, GoalRef, GoalView } from '@deepseek-ai/dsh-goal'

export const name = 'command-goal'
export const inject = ['commands', 'goals']

const USAGE = '用法：/goal [<目标>|clear|edit <目标>|pause|resume]'

type GoalCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'invalid-edit' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'clear' }

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never, label: string): never {
  throw new TypeError(`unknown ${label}: ${String(value)}`)
}
/* v8 ignore stop */

/** Parse only the grammar owned by `/goal`; arbitrary other input is an objective. */
function parseGoalCommand(rawInput: string): GoalCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: 'show' }
  const control = input.toLowerCase()
  if (control === 'clear') return { kind: 'clear' }
  if (control === 'pause') return { kind: 'pause' }
  if (control === 'resume') return { kind: 'resume' }
  if (control === 'edit') return { kind: 'invalid-edit' }
  if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() }
  return { kind: 'create', objective: input }
}

/** Human label for one durable goal phase. */
function phaseLabel(phase: GoalPhase): string {
  switch (phase) {
    case 'active': return '进行中'
    case 'paused': return '已暂停'
    case 'blocked': return '受阻'
    case 'complete': return '已完成'
    /* v8 ignore next 2 -- GoalPhase is closed and every member is handled above */
    default: return assertNever(phase, 'goal phase')
  }
}

/** Commands that are meaningful from one exact live state. */
function commandHint(goal: GoalView): string {
  if (goal.phase === 'active') {
    return goal.activation === 'armed'
      ? '/goal edit <目标>、/goal pause、/goal clear'
      : '/goal edit <目标>、/goal resume、/goal clear'
  }
  switch (goal.phase) {
    case 'paused':
    case 'blocked':
      return '/goal edit <目标>、/goal resume、/goal clear'
    case 'complete':
      return '/goal <目标>、/goal clear'
    /* v8 ignore next 2 -- the active branch and every non-active phase are handled above */
    default: return assertNever(goal.phase, 'goal phase')
  }
}

/** Render direct UI output without exposing compare-and-set internals. */
function renderGoal(title: string, goal: GoalView): CommandResult {
  const reason = goal.phase === 'blocked' ? goal.blockedReason : undefined
  /* v8 ignore next -- durable replay guarantees every blocked goal carries its validated reason */
  if (goal.phase === 'blocked' && reason === undefined) throw new TypeError('blocked goal is missing its reason')
  const blocker = reason === undefined ? [] : [`阻塞原因：${reason.code}: ${reason.message}`]
  return {
    kind: 'success',
    text: [
      title,
      `状态：${phaseLabel(goal.phase)}`,
      ...blocker,
      `目标：${goal.objective}`,
      `轮次：${goal.roundsStarted}/${goal.maxGoalRounds}`,
      `激活：${goal.activation}`,
      '',
      `可用命令：${commandHint(goal)}`,
    ].join('\n'),
  }
}

/** Exact current compare-and-set ref. */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

/** Direct error for an operation that requires a current goal. */
function missingGoal(action: string): CommandResult {
  return {
    kind: 'error',
    text: `当前未设置目标；/goal ${action} 需要一个目标。${USAGE}`,
  }
}

/** Execute one parsed human command through the domain that owns persistence. */
function executeGoalCommand(ctx: Context, invocation: CommandInvocation): CommandResult {
  const command = parseGoalCommand(invocation.rawInput)
  try {
    const current = ctx.goals.get(invocation.agent)
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? { kind: 'success', text: `当前未设置目标。\n${USAGE}` }
          : renderGoal('目标', current)
      case 'invalid-edit':
        return { kind: 'error', text: `编辑目标需要提供替换目标内容。\n${USAGE}` }
      case 'create':
        if (current !== undefined && current.phase !== 'complete') {
          return {
            kind: 'error',
            text: `已有一个${phaseLabel(current.phase)}的目标。使用 /goal edit <目标> 修改它，或用 /goal clear 清除后再替换。`,
          }
        }
        return renderGoal('目标已创建', ctx.goals.create(invocation.agent, { objective: command.objective }))
      case 'edit':
        if (current === undefined) return missingGoal('edit')
        if (current.phase === 'complete') {
          return renderGoal('目标已创建', ctx.goals.create(invocation.agent, { objective: command.objective }))
        }
        return renderGoal(
          '目标已更新',
          ctx.goals.edit(invocation.agent, goalRef(current), { objective: command.objective }),
        )
      case 'pause':
        if (current === undefined) return missingGoal('pause')
        return renderGoal('目标已暂停', ctx.goals.pause(invocation.agent, goalRef(current)))
      case 'resume':
        if (current === undefined) return missingGoal('resume')
        return renderGoal('目标已恢复', ctx.goals.resume(invocation.agent, goalRef(current)))
      case 'clear':
        if (current === undefined) return { kind: 'success', text: '没有需要清除的目标。' }
        ctx.goals.clear(invocation.agent, goalRef(current))
        return { kind: 'success', text: '目标已清除。' }
      /* v8 ignore next 2 -- GoalCommand is closed and every member is handled above */
      default: return assertNever(command, 'goal command')
    }
  } catch (error: unknown) {
    if (error instanceof GoalError) {
      return {
        kind: 'error',
        text: '目标命令对当前状态无效。运行 /goal 查看可用命令。',
      }
    }
    throw error
  }
}

/** Register the Codex-shaped `/goal` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'goal',
    description: '设置或查看长期任务的完成目标',
    input: { hint: '[<目标>|clear|edit <目标>|pause|resume]' },
    handler: invocation => executeGoalCommand(ctx, invocation),
  })
}
