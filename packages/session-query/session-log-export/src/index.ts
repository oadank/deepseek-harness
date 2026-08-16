/** Web Session-log download command over the host endpoint owned by ApiProxy. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'session-log-download'
export const inject = ['commands']

const REQUESTED: CommandResult = {
  kind: 'success',
  text: '已请求下载会话日志。',
}

/**
 * Register the Web-only `/export` command that the browser download plugin observes.
 * @param ctx - Host context carrying the human-command registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.commands.register({
    name: 'export',
    description: '下载本会话日志（ZIP 压缩包）',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'Web 端 /export 命令不接受路径参数。' }),
  }), 'session-log-download: command')
}
