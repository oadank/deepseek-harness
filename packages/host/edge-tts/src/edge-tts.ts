/**
 * Microsoft Edge TTS — native WebSocket client (free, no API key).
 * Ported from the retired apiproxy host surface into 0.1.5 Connection Fetch.
 * Aligns with Python edge-tts v7.2.8 DRM + headers; Sec-MS-GEC rides the URL.
 * @module @deepseek-ai/dsh-host-edge-tts/edge-tts
 */

import WebSocket from 'ws'
import { createHash, randomBytes } from 'node:crypto'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud'
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR_VERSION = '143'
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`
const WIN_EPOCH = 11644473600
const S_TO_NS = 1e9

/** Default Edge voice when the caller omits one. */
export const DEFAULT_EDGE_TTS_VOICE = 'zh-CN-XiaoxiaoNeural'
/** Single-attempt stream timeout; normal synthesis finishes in 1–3s. */
export const EDGE_TTS_MESSAGE_TIMEOUT_MS = 12_000
/** Total attempts: first try + up to two automatic retries. */
export const EDGE_TTS_MAX_ATTEMPTS = 3

function generateSecMsGec(): string {
  let ticks = Date.now() / 1000
  ticks += WIN_EPOCH
  ticks -= ticks % 300
  ticks *= S_TO_NS / 100
  const strToHash = `${Math.floor(ticks)}${TRUSTED_CLIENT_TOKEN}`
  return createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase()
}

function generateMuid(): string {
  return randomBytes(16).toString('hex').toUpperCase()
}

function uuid(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function getWssUrl(): string {
  return `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
    + `&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
}

function getWssHeaders(): Record<string, string> {
  return {
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': `muid=${generateMuid()};`,
  }
}

function edgeTtsOnce(text: string, voice: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWssUrl(), { headers: getWssHeaders() })
    const audioData: Buffer[] = []
    let messageTimeout: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = (done: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(connectTimeout)
      if (messageTimeout !== undefined) clearTimeout(messageTimeout)
      done()
    }

    // Connect timeout (10s).
    const connectTimeout = setTimeout(() => {
      ws.terminate()
      settle(() => reject(new Error('Edge TTS WebSocket connect timeout (10s)')))
    }, 10_000)

    ws.on('message', (rawData, isBinary) => {
      const buf = rawData as Buffer
      if (!isBinary) {
        const str = buf.toString('utf8')
        if (str.includes('turn.end')) {
          settle(() => resolve(Buffer.concat(audioData)))
          ws.close()
        }
        return
      }
      const separator = 'Path:audio\r\n'
      const idx = buf.indexOf(separator)
      if (idx !== -1) audioData.push(buf.subarray(idx + separator.length))
    })

    ws.on('error', (err) => {
      ws.terminate()
      settle(() => reject(err))
    })

    ws.on('open', () => {
      clearTimeout(connectTimeout)
      // Stream timeout (12s): keep the local production parameter.
      messageTimeout = setTimeout(() => {
        ws.terminate()
        settle(() => reject(new Error(`Edge TTS message timeout (${EDGE_TTS_MESSAGE_TIMEOUT_MS}ms)`)))
      }, EDGE_TTS_MESSAGE_TIMEOUT_MS)

      const speechConfig = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
              outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            },
          },
        },
      })
      const configMsg = `X-Timestamp:${Date()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${speechConfig}`
      ws.send(configMsg, { compress: true })

      const ssml = '<speak version=\'1.0\' xmlns=\'http://www.w3.org/2001/10/synthesis\' xml:lang=\'zh-CN\'>'
        + `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
      const ssmlMsg = `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${Date()}Z\r\nPath:ssml\r\n\r\n${ssml}`
      ws.send(ssmlMsg, { compress: true })
    })
  })
}

/**
 * Edge TTS with automatic retries: up to {@link EDGE_TTS_MAX_ATTEMPTS} attempts
 * (first + 2 retries), escalating delay 500ms/1s. Only the last error is thrown.
 * @param text - plain text to speak.
 * @param voice - Edge voice name (default {@link DEFAULT_EDGE_TTS_VOICE}).
 * @returns MP3 bytes (audio-24khz-48kbitrate-mono-mp3).
 */
export async function edgeTts(
  text: string,
  voice = DEFAULT_EDGE_TTS_VOICE,
): Promise<Buffer> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= EDGE_TTS_MAX_ATTEMPTS; attempt++) {
    try {
      return await edgeTtsOnce(text, voice)
    } catch (err) {
      lastErr = err
      if (attempt < EDGE_TTS_MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 500 * attempt))
      }
    }
  }
  throw lastErr
}
