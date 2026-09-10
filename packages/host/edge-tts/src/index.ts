/**
 * Host plugin: authenticated Edge TTS synthesis route on the Connection
 * shared API channel. Replaces the retired apiproxy `voice.tts` unary path
 * with a Connection Fetch route (same pattern as session.log export).
 * @module @deepseek-ai/dsh-host-edge-tts
 */

import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_EDGE_TTS_VOICE, edgeTts } from './edge-tts.ts'

export const name = 'edge-tts'
export const inject: string[] = []

/** Authenticated browser path for one synthesis request. */
export const EDGE_TTS_PATH = '/api/edge-tts'

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

/**
 * Register the `/api/edge-tts` synthesis route on the shared API channel.
 * @param ctx - Host context carrying Connection Fetch.
 */
export function apply(ctx: Context): void {
  connectionOf(ctx).fetch.register({
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
