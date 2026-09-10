/**
 * Host plugin: authenticated Edge TTS synthesis route on the Connection
 * shared API channel. Replaces the retired apiproxy `voice.tts` unary path
 * with a Connection Fetch route (same pattern as session.log export).
 * @module @deepseek-ai/dsh-host-edge-tts
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_EDGE_TTS_VOICE, edgeTts } from './edge-tts.ts'

export const name = 'edge-tts'
export const inject: string[] = []

/** Authenticated browser path for one synthesis request. */
export const EDGE_TTS_PATH = '/api/edge-tts'
/** Authenticated browser path for reading one stored voice object. */
export const VOICE_READ_PATH = '/api/voice'

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

function connectionOf(ctx: Context): ConnectionFetchHost {
  return Reflect.get(ctx, 'connection') as ConnectionFetchHost
}

function voiceObjectPath(voiceId: string): string {
  const sha = voiceId.replace(/^sha256:/, '')
  if (!/^[0-9a-f]{64}$/i.test(sha)) throw new Error('invalid voiceId')
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
}

/**
 * Register synthesis and voice-object read routes on the shared API channel.
 * @param ctx - Host context carrying Connection Fetch.
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
        const data = await readFile(voiceObjectPath(voiceId))
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
        // Endpoint and error text stay off the wire; the browser shows a generic failure.
        return new Response('edge tts synthesis failed', { status: 502 })
      }
    },
  })
}

export { DEFAULT_EDGE_TTS_VOICE, EDGE_TTS_MAX_ATTEMPTS, EDGE_TTS_MESSAGE_TIMEOUT_MS, edgeTts } from './edge-tts.ts'
