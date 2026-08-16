/**
 * Microsoft Edge TTS — 原生 WebSocket 客户端（免费，无需 API key）。
 * [本地改造 2026-08-16] 从 agents-to-im 移植进 DSH 本体（TTS 独立化，不再依赖外部工具）。
 * 对齐 Python edge-tts v7.2.8 的 DRM + Headers；Sec-MS-GEC 令牌放在 URL 参数里。
 * @module dsh-host-apiproxy/edge-tts
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

/**
 * Synthesize speech through the free Microsoft Edge endpoint.
 * @param text - plain text to speak.
 * @param voice - Edge voice name (default zh-CN-XiaoxiaoNeural).
 * @returns MP3 bytes (audio-24khz-48kbitrate-mono-mp3).
 */
export function edgeTts(text: string, voice = 'zh-CN-XiaoxiaoNeural'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWssUrl(), { headers: getWssHeaders() })
    const audioData: Buffer[] = []
    let messageTimeout: ReturnType<typeof setTimeout> | undefined

    const connectTimeout = setTimeout(() => {
      ws.terminate()
      reject(new Error('Edge TTS WebSocket connect timeout (10s)'))
    }, 10_000)

    ws.on('message', (rawData, isBinary) => {
      // ws 默认 binaryType='nodebuffer'：运行时数据就是 Buffer。
      const buf = rawData as Buffer
      if (!isBinary) {
        const str = buf.toString('utf8')
        if (str.includes('turn.end')) {
          if (messageTimeout !== undefined) clearTimeout(messageTimeout)
          resolve(Buffer.concat(audioData))
          ws.close()
        }
        return
      }
      const separator = 'Path:audio\r\n'
      const idx = buf.indexOf(separator)
      if (idx !== -1) audioData.push(buf.subarray(idx + separator.length))
    })

    ws.on('error', (err) => {
      clearTimeout(connectTimeout)
      reject(err)
    })

    ws.on('open', () => {
      clearTimeout(connectTimeout)
      messageTimeout = setTimeout(() => {
        ws.close()
        reject(new Error('Edge TTS message timeout (30s)'))
      }, 30_000)

      const speechConfig = JSON.stringify({
        context: { synthesis: { audio: {
          metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        } } },
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
