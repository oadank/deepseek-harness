import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { toPiContext } from '../src/context.ts'
import { toPiAssistant } from '../src/replay.ts'

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

const attachments = {
  readImage: vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1) })),
} as unknown as AttachmentStore

function request(messages: GenerateOptions['messages']): GenerateOptions {
  return {
    provider: 'openai',
    model: 'gpt-4.1',
    system: 'system prompt',
    tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object' } }],
    messages,
  }
}

function user(content: ContentBlock[]): Message {
  return createUserMessage({ content, source: { kind: 'plugin', plugin: 'test' } })
}

function history(role: 'system' | 'assistant', content: ContentBlock[]): Message {
  return createMessage({ role, content, source: { kind: 'plugin', plugin: 'test' } })
}

describe('pi-ai request context conversion', () => {
  it('omits absent and empty request-level optional fields', () => {
    const base = { provider: 'openai', model: 'gpt-4.1', messages: [] }
    expect(toPiContext(base)).toEqual({ messages: [] })
    expect(toPiContext({ ...base, tools: [] })).toEqual({ messages: [] })
  })

  it('converts complete text-only history and rejects nested images without storage', () => {
    const callId = CallId('call-1')
    expect(toPiContext(request([
      history('system', [{ type: 'text', text: 'history system' }]),
      history('assistant', [{ type: 'tool-call', id: callId, name: 'lookup', arguments: '{}' }]),
      user([
        { type: 'text', text: 'after tool' },
        {
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: '' }],
        },
      ]),
    ]))).toMatchObject({
      systemPrompt: 'system prompt',
      tools: [{ name: 'lookup' }],
      messages: [
        { role: 'user', content: 'history system' },
        { role: 'assistant' },
        { role: 'user', content: 'after tool' },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'lookup',
          content: [{ type: 'text', text: '(no output)' }],
          isError: false,
        },
      ],
    })

    expect(() => toPiContext(request([user([{
      type: 'tool-result',
      toolCallId: callId,
      content: [{ type: 'image', attachment: ref }],
    }])]))).toThrow(/durable attachment service/)
  })

  it('resolves user and tool-result images while preserving explicit fallbacks', async () => {
    const callId = CallId('missing-call')
    const knownCallId = CallId('known-call')
    const context = await toPiContext(request([
      user([{ type: 'text', text: '' }]),
      history('assistant', [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: knownCallId, name: 'lookup', arguments: '{}' },
      ]),
      user([
        { type: 'image', attachment: ref },
        { type: 'text', text: 'caption' },
        { type: 'reasoning', text: 'ignored' },
      ]),
      user([{
        type: 'tool-result',
        toolCallId: knownCallId,
        content: [{ type: 'text', text: '' }],
      }]),
      user([{
        type: 'tool-result',
        toolCallId: callId,
        isError: true,
        content: [
          { type: 'tool-result', toolCallId: callId, content: [] },
          { type: 'image', attachment: ref },
        ],
      }]),
    ]), attachments, true)

    expect(context.messages).toEqual([
      { role: 'user', content: '', timestamp: 0 },
      expect.objectContaining({ role: 'assistant' }),
      {
        role: 'user',
        content: [
          { type: 'image', data: 'AQ==', mimeType: 'image/png' },
          { type: 'text', text: 'caption' },
        ],
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'known-call',
        toolName: 'lookup',
        content: [{ type: 'text', text: '(no output)' }],
        isError: false,
        timestamp: 0,
      },
      {
        role: 'toolResult',
        toolCallId: 'missing-call',
        toolName: 'unknown',
        content: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
        isError: true,
        timestamp: 0,
      },
    ])
  })

  it('recursively converts nested tool-result text and images', async () => {
    const callId = CallId('nested-call')
    const context = await toPiContext(request([user([{
      type: 'tool-result',
      toolCallId: callId,
      content: [
        {
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: 'nested text' }],
        },
        {
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'image', attachment: ref }],
        },
      ],
    }])]), attachments)

    expect(context.messages).toEqual([{
      role: 'toolResult',
      toolCallId: 'nested-call',
      toolName: 'unknown',
      content: [
        { type: 'text', text: 'nested text' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      ],
      isError: false,
      timestamp: 0,
    }])
  })

  it('flattens nested text-only tool results and ignores other block types without storage', () => {
    const callId = CallId('nested-text')
    expect(toPiContext(request([user([{
      type: 'tool-result',
      toolCallId: callId,
      content: [
        { type: 'chart', data: 'ignored' } as unknown as ContentBlock,
        {
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: 'nested' }],
        },
      ],
    }])]))).toMatchObject({
      messages: [{
        role: 'toolResult',
        content: [{ type: 'text', text: 'nested' }],
      }],
    })
  })


  it('keeps empty text-only users while separating result-only messages', () => {
    const callId = CallId('unknown-call')
    expect(toPiContext(request([
      user([]),
      history('assistant', [
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: CallId('other-call'), name: 'lookup', arguments: '{}' },
      ]),
      user([{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'result' }],
      }]),
    ]))).toMatchObject({
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant' },
        { role: 'toolResult', toolName: 'unknown' },
      ],
    })
  })

  it('flattens voice blocks into transcript text on the text-only path (本地改造)', () => {
    const context = toPiContext(request([
      user([{
        type: 'voice',
        attachment: {
          voiceId: 'sha256:voice', mediaType: 'audio/mp4', bytes: 100, durationMs: 3200,
          transcript: '帮我查一下明天的天气',
        },
      }]),
      history('assistant', [{ type: 'text', text: '好的' }]),
    ]))
    expect(context.messages).toEqual([
      { role: 'user', content: '[用户发送了一条语音（时长 3 秒），识别内容：帮我查一下明天的天气]', timestamp: 0 },
      expect.objectContaining({ role: 'assistant' }),
    ])
  })

  it('degrades voice blocks to local-path text without a transcript (本地改造)', () => {
    const context = toPiContext(request([
      user([{
        type: 'voice',
        attachment: { voiceId: 'sha256:voice', mediaType: 'audio/mp4', bytes: 100 },
      }]),
    ]))
    expect(context.messages[0]).toEqual({
      role: 'user',
      content: expect.stringMatching(/^\[用户发送了一条语音，本地语音文件路径: .*\]$/),
      timestamp: 0,
    })
  })

  it('flattens voice blocks into transcript text on the image path (本地改造)', async () => {
    const context = await toPiContext(request([
      user([{
        type: 'voice',
        attachment: {
          voiceId: 'sha256:voice', mediaType: 'audio/mp4', bytes: 100,
          transcript: '语音内容',
        },
      }]),
    ]), attachments, true)
    expect(context.messages[0]).toEqual({
      role: 'user',
      content: '[用户发送了一条语音，识别内容：语音内容]',
      timestamp: 0,
    })
  })

  it('handles in-history system and assistant messages explicitly on the image path', async () => {
    await expect(toPiContext(request([
      history('system', [{ type: 'image', attachment: ref }]),
    ]), attachments, true)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })

    await expect(toPiContext(request([
      history('system', [{ type: 'text', text: 'history system' }]),
      history('assistant', [{ type: 'text', text: 'answer' }]),
      user([{ type: 'text', text: 'plain' }]),
    ]), attachments, true)).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'history system' },
        { role: 'assistant' },
        { role: 'user', content: 'plain' },
      ],
    })

    expect(() => toPiAssistant(
      history('assistant', [{ type: 'image', attachment: ref }]),
    )).toThrow(/assistant image output/)
  })
})
