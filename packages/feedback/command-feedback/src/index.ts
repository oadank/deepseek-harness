/**
 * Session feedback event plus the human-facing `/feedback` producer. Recording
 * appends one authoritative log-only event and does not start model work. The
 * append is eager but unflushed, so acknowledgement reports that the entry is
 * logged, not that it reached disk.
 * @module @deepseek-ai/dsh-command-feedback
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionTelemetryBackend, SessionTelemetrySharingStatus } from '@deepseek-ai/dsh-session-telemetry'
import type { Session } from '@deepseek-ai/dsh-session'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'

export const name = 'command-feedback'
export const inject = ['commands']

const USAGE = '用法：/feedback <内容>'

/** Fail closed when a future sharing status reaches the sentence switch. */
/* v8 ignore next 3 -- only the ignored default arm calls this; the closed union cannot reach it via the public API. */
function assertNever(value: never): never {
  throw new Error(`command-feedback: unsupported sharing status ${JSON.stringify(value)}`)
}

/** The acknowledgement's sharing sentence for a disclosed policy. */
function sharingSentence(sharing: SessionTelemetrySharingStatus): string {
  switch (sharing) {
    case 'full':
      return '会话共享已开启。'
    case 'feedback-only':
      return '会话共享受反馈门控；记录反馈会释放会话前缀用于共享。'
    case 'disabled':
      return '会话共享已关闭。'
    /* v8 ignore next 2 -- the seam's closed union cannot reach the default; a future status must be given a sentence here. */
    default:
      return assertNever(sharing)
  }
}

/**
 * The sharing disclosure appended to the acknowledgement: the mounted
 * backend's disclosed policy, or a "not configured" notice when no backend
 * is mounted. Read through the plugin context so the command still works
 * when the telemetry service is absent.
 * @param telemetry - the mounted telemetry service, or undefined.
 * @returns one sentence describing this session's sharing policy.
 */
function sharingDisclosure(telemetry: SessionTelemetryBackend | undefined): string {
  if (telemetry === undefined) {
    return '会话共享未配置。'
  }
  return sharingSentence(telemetry.sharing)
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One recorded human remark about this session. Log-only and independent
     * of its trigger; it never enters model context or derived history.
     */
    'feedback/record': { text: string }
  }
}

/**
 * Record feedback independently of any UI trigger.
 * @param session - session the feedback describes.
 * @param text - human-authored feedback; surrounding whitespace is discarded.
 * @throws {TypeError} when the normalized text is empty.
 */
export function recordFeedback(session: Session, text: string): void {
  const normalized = text.trim()
  if (normalized.length === 0) throw new TypeError('feedback text must not be empty')
  session.append('feedback/record', { text: normalized })
}

/**
 * Validate, record, and acknowledge one feedback entry. Returning an error
 * leaves no `feedback/record` event.
 * @param invocation - receiving agent, raw command input, and UI cancellation.
 * @param ctx - plugin context used to read the optional telemetry service.
 * @returns an acknowledgement containing the receiving session and anonymous
 * user ids plus the session-sharing disclosure, or a usage error when no
 * feedback text was supplied.
 */
function executeFeedbackCommand(invocation: CommandInvocation, ctx: Context): CommandResult {
  if (invocation.rawInput.trim().length === 0) {
    return { kind: 'error', text: `请输入反馈内容。${USAGE}` }
  }
  recordFeedback(invocation.agent.session, invocation.rawInput)
  const telemetry = ctx.get('sessionTelemetry')
  return {
    kind: 'success',
    text: `已记录对会话 ${invocation.agent.session.id} 的反馈\n匿名用户：${getOrCreateAnonymousUserId()}。${sharingDisclosure(telemetry)}`,
  }
}

/** Register the global `/feedback` command for every composed command adapter. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'feedback',
    description: '记录对本会话的反馈',
    input: { hint: '<内容>' },
    recordInput: false,
    handler: invocation => executeFeedbackCommand(invocation, ctx),
  })
}
