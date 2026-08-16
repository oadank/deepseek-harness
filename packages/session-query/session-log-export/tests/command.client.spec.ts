import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation } from '@deepseek-ai/dsh-commands'
import * as SessionLogDownload from '../src/index.ts'

describe('/export Web download command', () => {
  it('registers one pathless command and removes it with the plugin fiber', async () => {
    let descriptor: CommandDefinition | undefined
    const ctx = new Context()
    ctx.provide('commands', {
      register(next: CommandDefinition) {
        descriptor = next
        return () => { descriptor = undefined }
      },
    } as never)
    const fiber = await ctx.plugin(SessionLogDownload)

    expect(descriptor).toMatchObject({
      name: 'export',
      description: '下载本会话日志（ZIP 压缩包）',
    })
    const invoke = (rawInput: string) => descriptor?.handler({ rawInput } as CommandInvocation)
    await expect(invoke('')).resolves.toEqual({
      kind: 'success', text: '已请求下载会话日志。',
    })
    await expect(invoke(' output.zip')).resolves.toEqual({
      kind: 'error', text: 'Web 端 /export 命令不接受路径参数。',
    })

    await fiber.dispose()
    expect(descriptor).toBeUndefined()
  })
})
