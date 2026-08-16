// @vitest-environment jsdom
// Voice-message rendering tails: the user-bubble voice card plays a
// session-authorized recording and degrades when loading fails. The card is
// presentation only — playback bytes come through the injected loadVoice
// loader, mirroring the image gallery's loadImage contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { VoiceAttachmentRef } from '@deepseek-ai/dsh-client-connection/client'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { zh } from '../src/client/locales.ts'

const t: ChatNodeViewProps['t'] = makeTranslate(zh, commonZh)

function voiceProps(attachment: VoiceAttachmentRef, loadVoice: (ref: VoiceAttachmentRef) => Promise<string>): ChatNodeViewProps<'user' | 'steering'> {
  const viewNode: ChatConversationViewNode = {
    key: 'fixture:user:1',
    kind: 'user',
    id: '1',
    target: 'chat',
    anchorSeq: 1,
    location: { kind: 'session' },
    visibility: 'visible',
    data: {
      content: [{ type: 'voice', attachment }],
      time: new Date(),
    },
  }
  return {
    node: viewNode,
    t,
    loadImage: () => Promise.resolve('blob:image'),
    loadVoice,
  } as unknown as ChatNodeViewProps<'user' | 'steering'>
}

beforeEach(() => {
  // jsdom does not implement media playback; play/pause resolve quietly.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: vi.fn(() => Promise.resolve()),
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: vi.fn(() => Promise.resolve()),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('UserMessageNodeView voice card', () => {
  it('renders a play control with the recorder-reported duration', () => {
    const view = render(<UserMessageNodeView {...voiceProps({
      voiceId: 'sha256:v', mediaType: 'audio/webm', bytes: 100, durationMs: 4200,
    }, vi.fn(() => Promise.resolve('blob:voice')))} />)
    expect(view.getByLabelText('播放语音')).toBeTruthy()
    expect(view.getByText('5s')).toBeTruthy()
  })

  it('loads the session-authorized bytes and plays on click', async () => {
    const load = vi.fn(() => Promise.resolve('blob:voice'))
    const view = render(<UserMessageNodeView {...voiceProps({
      voiceId: 'sha256:v', mediaType: 'audio/webm', bytes: 100, durationMs: 1200,
    }, load)} />)
    await waitFor(() => expect(view.container.querySelector('audio')).not.toBeNull())
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'sha256:v' }))
    const audio = view.container.querySelector('audio') as HTMLAudioElement
    expect(audio.src).toBe('blob:voice')

    fireEvent.click(view.getByLabelText('播放语音'))
    // jsdom does not fire media events from a stubbed play(); simulate the
    // browser's onPlay so the control flips to the pause affordance.
    fireEvent.play(view.container.querySelector('audio') as HTMLAudioElement)
    await waitFor(() => expect(view.getByLabelText('暂停播放')).toBeTruthy())
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
  })

  it('disables the control when loading fails', async () => {
    const view = render(<UserMessageNodeView {...voiceProps({
      voiceId: 'sha256:v', mediaType: 'audio/webm', bytes: 100,
    }, vi.fn(() => Promise.reject(new Error('boom'))))} />)
    const button = view.getByLabelText('播放语音') as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(true))
  })
})
