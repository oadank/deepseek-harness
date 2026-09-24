/**
 * Host plugin: Edge TTS Fetch routes plus automatic assistant voice-reply.
 * Replaces retired apiproxy voice.tts / sendVoiceMessage host duties for the
 * durable voice/reply path.
 * @module @deepseek-ai/dsh-host-edge-tts
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EDGE_TTS_VOICE, edgeTts } from './edge-tts.ts'
import { synthesizeReplyVoice } from './synthesize.ts'
import { saveVoiceFile, voiceStorageRoot } from './voice-store.ts'

export const name = 'edge-tts'
/** Connection for Fetch routes; agents for turn-end voice-reply. */
export const inject = ['connection', 'agents']

/** Authenticated browser path for one synthesis request. */
export const EDGE_TTS_PATH = '/api/edge-tts'
/** Authenticated browser path for reading one stored voice object. */
export const VOICE_READ_PATH = '/api/voice'

/** Default max characters spoken for one auto voice reply. */
const MAX_REPLY_CHARS = 800
/** Minimum speakable characters after markdown strip. */
const MIN_REPLY_CHARS = 2

/** JSON body of one synthesis request. */
interface EdgeTtsRequestBody {
  text?: unknown
  voice?: unknown
}

interface ConnectionFetchHost {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

interface AgentsHost {
  get(id: string): { session: Session } | undefined
}

function connectionOf(ctx: Context): ConnectionFetchHost {
  return Reflect.get(ctx, 'connection') as ConnectionFetchHost
}

function agentsOf(ctx: Context): AgentsHost {
  return Reflect.get(ctx, 'agents') as AgentsHost
}

function voicePathOf(voiceId: string): string {
  const sha = voiceId.replace(/^sha256:/, '')
  if (!/^[0-9a-f]{64}$/i.test(sha)) throw new Error('invalid voiceId')
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
}

function assistantTextOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown }
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('').trim()
}

/** Pending assistant text per session for the current turn. */
const pendingReply = new Map<string, { turn: number; text: string }>()

function voiceReplyEnabled(): boolean {
  const v = process.env.DSH_VOICE_REPLY
  // Default on; DSH_VOICE_REPLY=0 disables.
  return v !== '0' && v?.toLowerCase() !== 'false'
}

/**
 * Register synthesis/read routes and automatic voice-reply on completed turns.
 * @param ctx - Host context carrying Connection and Agents.
 */
export function apply(ctx: Context): void {
  const connection = connectionOf(ctx)
  connection.fetch.register({
    path: VOICE_READ_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const voiceId = new URL(request.url).searchParams.get('voiceId')
      if (voiceId === null || voiceId === '') {
        return new Response('missing voiceId', { status: 400 })
      }
      try {
        const data = await readFile(voicePathOf(voiceId))
        if (request.method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'Content-Length': String(data.byteLength) },
          })
        }
        return new Response(new Uint8Array(data), {
          status: 200,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Content-Length': String(data.byteLength),
            'Cache-Control': 'private, max-age=31536000, immutable',
          },
        })
      } catch {
        return new Response('voice not found', { status: 404 })
      }
    },
  })
  connection.fetch.register({
    path: EDGE_TTS_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      let body: EdgeTtsRequestBody
      try {
        body = await request.json() as EdgeTtsRequestBody
      } catch {
        return new Response('invalid JSON body', { status: 400 })
      }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text.length === 0) {
        return new Response('missing text', { status: 400 })
      }
      if (text.length > 20_000) {
        return new Response('text too long', { status: 413 })
      }
      const voice = typeof body.voice === 'string' && body.voice.trim() !== ''
        ? body.voice.trim()
        : DEFAULT_EDGE_TTS_VOICE
      try {
        const audio = await edgeTts(text, voice)
        return new Response(new Uint8Array(audio), {
          status: 200,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Content-Length': String(audio.byteLength),
            'Cache-Control': 'no-store',
          },
        })
      } catch {
        return new Response('edge tts synthesis failed', { status: 502 })
      }
    },
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!voiceReplyEnabled()) return
    switch (event.type) {
      case 'assistant/message': {
        if (event.data.interrupted === true) return
        const text = assistantTextOf(event.data.message.content)
        if (text.length >= MIN_REPLY_CHARS) {
          pendingReply.set(session.id, { turn: event.data.turn, text })
        }
        return
      }
      case 'turn/end': {
        if (event.data.reason.kind !== 'completed' && event.data.reason.kind !== 'max-tokens') return
        const pending = pendingReply.get(session.id)
        pendingReply.delete(session.id)
        if (pending === undefined || pending.turn !== event.data.turn) return
        if (pending.text.length > MAX_REPLY_CHARS) return
        // Fire-and-forget: never block the loop teardown on TTS.
        void (async () => {
          try {
            const audio = await synthesizeReplyVoice(pending.text)
            if (audio === null) return
            const ref = await saveVoiceFile(
              voiceStorageRoot(),
              audio.data,
              audio.mediaType,
              audio.durationMs,
              pending.text,
            )
            // Only append if this session is still live on the same agent tree.
            const live = agentsOf(ctx).get(session.id)
            if (live === undefined || live.session !== session) return
            session.append('voice/reply', {
              turn: pending.turn,
              voiceId: ref.voiceId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              ...(ref.durationMs === undefined ? {} : { durationMs: ref.durationMs }),
              transcript: ref.transcript ?? pending.text,
            })
          } catch {
            // Synthesis/storage failure must never crash the host loop.
          }
        })()
        return
      }
      default:
        return
    }
  })
}

export { DEFAULT_EDGE_TTS_VOICE, EDGE_TTS_MAX_ATTEMPTS, EDGE_TTS_MESSAGE_TIMEOUT_MS, edgeTts } from './edge-tts.ts'
export { saveVoiceFile, voiceObjectPath, voiceStorageRoot, type VoiceObjectRef } from './voice-store.ts'
export { stripMarkdown, synthesizeReplyVoice, type SynthesizedVoice } from './synthesize.ts'
