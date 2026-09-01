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
 * [本地改造 2026-09-01] 单次尝试 12s 硬超时 + 自动重试（最多 3 次，间隔递增）：
 * Edge 免费端点走公网 WSS，偶发握手失败/DRM 令牌瞬失效/代理链路抖动，
 * 一次失败直接把错误抛给上层会让语音回复整条挂掉，重试即可自愈。
 * @param text - plain text to speak.
 * @param voice - Edge voice name (default zh-CN-XiaoxiaoNeural).
 * @returns MP3 bytes (audio-24khz-48kbitrate-mono-mp3).
 */
function edgeTtsOnce(text: string, voice: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWssUrl(), { headers: getWssHeaders() })
    const audioData: Buffer[] = []
    let messageTimeout: ReturnType<typeof setTimeout> | undefined
    // 防止 resolve/reject 之后的迟到事件再次回调（ws.terminate 后 error 事件仍可能触发）。
    let settled = false
    const settle = (done: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimeout)
      if (messageTimeout !== undefined) clearTimeout(messageTimeout)
      done()
    }

    // 连接超时（10秒）
    const connectTimeout = setTimeout(() => {
      ws.terminate()
      settle(() => reject(new Error('Edge TTS WebSocket connect timeout (10s)')))
    }, 10_000)

    ws.on('message', (rawData, isBinary) => {
      // ws 默认 binaryType='nodebuffer'：运行时数据就是 Buffer。
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
      // 收流超时（12秒）：Edge 正常 1-3 秒完成合成，超时基本等于链路异常，交给重试层。
      messageTimeout = setTimeout(() => {
        ws.terminate()
        settle(() => reject(new Error('Edge TTS message timeout (12s)')))
      }, 12_000)

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

/** 单次尝试硬超时基数：连接 10s + 收流 12s，正常合成 1-3 秒即可完成。 */
const MAX_ATTEMPTS = 3

/**
 * 带重试的 Edge TTS：最多 3 次尝试（首次 + 2 次重试），失败间隔递增（500ms/1s）。
 * 全部失败才把最后一次的错误抛给上层。
 */
export async function edgeTts(text: string, voice = 'zh-CN-XiaoxiaoNeural'): Promise<Buffer> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await edgeTtsOnce(text, voice)
    } catch (err) {
      lastErr = err
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }
  throw lastErr
}
