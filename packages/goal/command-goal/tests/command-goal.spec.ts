import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import GoalService from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-goal'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandGoal from '@deepseek-ai/dsh-command-goal'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

/** Build a live idle agent accepted by the exact-identity goal service. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  // Store-created: the command executor durably logs lifecycle events on it.
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

/** Mount the real command registry, goal domain, and producer. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  const plugin = await ctx.plugin(commandGoal)
  const { agent, session } = stubAgent(ctx, `command-goal-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session, plugin }
}

/** The log with executor-owned command lifecycle bookkeeping stripped (goal assertions target domain events). */
function domainEvents(session: Session): readonly Session['events'][number][] {
  const lifecycle = new Set<number>()
  for (const event of session.events) {
    if (event.type !== 'command/run' && event.type !== 'command/done') continue
    lifecycle.add(event.seq)
    // The zero-step wrap around a lifecycle event is bookkeeping too.
    const before = session.events[event.seq - 1]
    const after = session.events[event.seq + 1]
    if (before?.type === 'turn/start') lifecycle.add(before.seq)
    if (after?.type === 'turn/end') lifecycle.add(after.seq)
  }
  return session.events.filter(event => !lifecycle.has(event.seq))
}

/** Execute `/goal` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>['result']> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/goal${suffix}`,
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('goal command was not registered')
  return execution.result
}

/** Current exact compare-and-set ref. */
function ref(goal: NonNullable<ReturnType<GoalService['get']>>): GoalRef {
  return { id: goal.id, revision: goal.revision }
}

describe('@deepseek-ai/dsh-command-goal registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const test = await harness()
    expect(commandGoal.name).toBe('command-goal')
    expect(commandGoal.inject).toEqual(['commands', 'goals'])
    expect('default' in commandGoal).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandGoal)).toBe(commandGoal)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'goal',
      description: '设置或查看长期任务的完成目标',
      input: { hint: '[<目标>|clear|edit <目标>|pause|resume]' },
    })
    expect(test.ctx.commands.find(test.agent, 'goal')).toBeDefined()

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'goal')).toBeUndefined()
  })
})

describe('/goal human command', () => {
  it('shows an empty status without mutating the session', async () => {
    const test = await harness()
    await expect(run(test)).resolves.toEqual({
      kind: 'success',
      text: '当前未设置目标。\n用法：/goal [<目标>|clear|edit <目标>|pause|resume]',
    })
    expect(domainEvents(test.session)).toEqual([])
  })

  it('creates a trimmed objective and refuses silent replacement of unfinished work', async () => {
    const test = await harness()
    const created = await run(test, '\n  finish the release  ')
    expect(created.kind).toBe('success')
    expect(created.text).toContain('目标已创建\n状态：进行中')
    expect(created.text).toContain('目标：finish the release')
    expect(created.text).toContain('轮次：0/256')
    expect(created.text).toContain('激活：armed')
    expect(test.ctx.goals.get(test.agent)?.objective).toBe('finish the release')
    expect(domainEvents(test.session).map(event => event.type)).toEqual(['goal/change'])

    const count = domainEvents(test.session).length
    await expect(run(test, ' replacement')).resolves.toEqual({
      kind: 'error',
      text: '已有一个进行中的目标。使用 /goal edit <目标> 修改它，或用 /goal clear 清除后再替换。',
    })
    expect(domainEvents(test.session)).toHaveLength(count)
  })

  it('treats only exact control words as controls', async () => {
    const test = await harness()
    await run(test, ' pause everything only after verification')
    expect(test.ctx.goals.get(test.agent)?.objective).toBe('pause everything only after verification')
  })

  it('edits inline, requires an objective, and starts a new goal when the old one is complete', async () => {
    const empty = await harness()
    const invalidEdit = await run(empty, ' edit')
    expect(invalidEdit.kind).toBe('error')
    expect(invalidEdit.text).toContain('编辑目标需要提供替换目标内容')
    const missingEdit = await run(empty, ' edit replacement')
    expect(missingEdit.kind).toBe('error')
    expect(missingEdit.text).toContain('/goal edit 需要一个目标')

    const test = await harness()
    await run(test, ' first')
    const first = test.ctx.goals.get(test.agent)!
    const updated = await run(test, ' EDIT\n  second  ')
    expect(updated.kind).toBe('success')
    expect(updated.text).toContain('目标已更新')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ id: first.id, objective: 'second', revision: 2 })

    const current = test.ctx.goals.get(test.agent)!
    test.ctx.goals.complete(test.agent, ref(current))
    const replacement = await run(test, ' edit third')
    expect(replacement.kind).toBe('success')
    expect(replacement.text).toContain('目标已创建')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ objective: 'third', revision: 1 })
    expect(test.ctx.goals.get(test.agent)?.id).not.toBe(first.id)
  })

  it('returns direct missing-state results for pause, resume, and clear', async () => {
    const test = await harness()
    const missingPause = await run(test, ' pause')
    expect(missingPause.kind).toBe('error')
    expect(missingPause.text).toContain('/goal pause 需要一个目标')
    const missingResume = await run(test, ' resume')
    expect(missingResume.kind).toBe('error')
    expect(missingResume.text).toContain('/goal resume 需要一个目标')
    await expect(run(test, ' clear')).resolves.toEqual({ kind: 'success', text: '没有需要清除的目标。' })
  })

  it('pauses, resumes, clears, and converts expected domain rejections to command errors', async () => {
    const test = await harness()
    await run(test, ' work')
    const redundantResume = await run(test, ' RESUME')
    expect(redundantResume).toEqual({
      kind: 'error',
      text: '目标命令对当前状态无效。运行 /goal 查看可用命令。',
    })
    const paused = await run(test, ' PAUSE')
    expect(paused.kind).toBe('success')
    expect(paused.text).toContain('目标已暂停')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'paused', activation: 'disarmed' })
    const resumed = await run(test, ' resume')
    expect(resumed.kind).toBe('success')
    expect(resumed.text).toContain('目标已恢复')
    expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'active', activation: 'armed' })
    await expect(run(test, ' clear')).resolves.toEqual({ kind: 'success', text: '目标已清除。' })
    expect(test.ctx.goals.get(test.agent)).toBeUndefined()
  })

  it('shows every durable phase and distinguishes disarmed active state', async () => {
    const test = await harness()
    test.ctx.goals.create(test.agent, { objective: 'state matrix', maxGoalRounds: 1 })
    test.ctx.goals.disarm(test.agent)
    expect((await run(test)).text)
      .toContain('状态：进行中\n目标：state matrix\n轮次：0/1\n激活：disarmed')
    expect((await run(test)).text).toContain('/goal resume')

    let goal = test.ctx.goals.get(test.agent)!
    goal = test.ctx.goals.resume(test.agent, ref(goal))
    goal = test.ctx.goals.pause(test.agent, ref(goal))
    expect((await run(test)).text).toContain('状态：已暂停')

    goal = test.ctx.goals.resume(test.agent, ref(goal))
    goal = test.ctx.goals.block(test.agent, ref(goal), {
      code: 'upstream-unavailable',
      message: 'Provider unavailable',
    })
    const blocked = await run(test)
    expect(blocked.text).toContain('状态：受阻')
    expect(blocked.text).toContain('阻塞原因：upstream-unavailable: Provider unavailable')

    goal = test.ctx.goals.resume(test.agent, ref(goal))
    test.ctx.goals.complete(test.agent, ref(goal))
    const complete = await run(test)
    expect(complete.text).toContain('状态：已完成')
    expect(complete.text).toContain('可用命令：/goal <目标>、/goal clear')
  })

  it('does not turn unexpected implementation failures into expected command results', async () => {
    const test = await harness()
    vi.spyOn(test.ctx.goals, 'get').mockImplementationOnce(() => { throw new Error('unexpected failure') })
    await expect(run(test)).rejects.toThrow('unexpected failure')
  })
})
