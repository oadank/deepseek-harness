/**
 * Durable voice-object storage and local ASR transcription, mirroring the
 * content-addressed attachment layout below `DSH_HOME/attachments/v1`.
 * [本地改造 2026-08-16] voice message support: browser recordings land in the
 * same objects pool as images (sha256-addressed), then transcode to WAV for
 * the local sherpa-onnx ASR service. A failed transcription never blocks the
 * message — the block keeps no transcript and serialization degrades the copy.
 * @module @deepseek-ai/dsh-host-apiproxy/voice
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import type { VoiceAttachmentRef, VoiceMediaType } from './api/sessions.ts'
import { edgeTts } from './edge-tts.ts'

/** ASR media types accepted from the browser wire. */
export const VOICE_MEDIA_TYPES: readonly VoiceMediaType[] = [
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav',
]

/** Maximum encoded bytes accepted for one voice object. */
export const MAX_VOICE_BYTES = 25 * 1024 * 1024

/** Absolute versioned storage root (same layout as the attachment backend). */
export function voiceStorageRoot(configuredHome?: string): string {
  const home = configuredHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(join(home, 'attachments', 'v1'))
}

/** Resolve the absolute object path for one voice reference. */
export function voiceObjectPath(root: string, voiceId: string): string {
  return objectPath(root, voiceId.replace(/^sha256:/, ''))
}

function objectPath(root: string, sha256: string): string {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

/**
 * Store immutable voice bytes below a versioned root, content-addressed by
 * sha256 exactly like image objects. A concurrent duplicate write resolves to
 * the existing object; a conflicting target with different bytes is an error.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param data - encoded browser recording bytes.
 * @param mediaType - declared recording container format.
 * @param durationMs - optional recorder-reported length.
 * @returns durable content-addressed reference.
 */
export async function saveVoiceFile(
  root: string,
  data: Uint8Array,
  mediaType: VoiceMediaType,
  durationMs?: number,
): Promise<VoiceAttachmentRef> {
  if (data.byteLength > MAX_VOICE_BYTES) {
    throw new Error(`Voice object exceeds the ${MAX_VOICE_BYTES}-byte limit.`)
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const target = objectPath(root, sha256)
  await mkdir(bucket, { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(data)
    await handle.close()
    handle = undefined
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw new Error(`Unable to persist voice object: ${String(error)}`, { cause: error })
    }
    // A duplicate sha256 target already exists; its bytes are identical by
    // construction, so the concurrent writer's object is the same object.
  }
  return {
    voiceId: `sha256:${sha256}`,
    mediaType,
    bytes: data.byteLength,
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

/**
 * Read one content-addressed voice object.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @returns stored bytes and the reference.
 */
export async function readVoiceFile(root: string, ref: VoiceAttachmentRef): Promise<{ ref: VoiceAttachmentRef; data: Uint8Array }> {
  const data = new Uint8Array(await readFile(voiceObjectPath(root, ref.voiceId)))
  return { ref, data }
}

/** Default ffmpeg binary; overridable for non-Windows deployments. */
export const FFMPEG_BIN = process.env.DSH_VOICE_FFMPEG_BIN
  ?? 'C:\\Users\\oadan\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'

/** Default local ASR endpoint (sherpa-onnx SenseVoice service). */
export const ASR_SERVICE_URL = process.env.DSH_ASR_SERVICE_URL ?? 'http://127.0.0.1:18790/transcribe'

/**
 * Transcribe one recording through the local ASR service. The browser container
 * (webm/ogg) is transcoded to 16 kHz mono WAV first, since sherpa-onnx reads
 * WAV directly. Never throws on recognition failure — returns an empty string
 * so the caller can degrade the model copy.
 * @param audioPath - absolute path of the stored recording.
 * @returns recognized text, or '' when the service is unavailable or fails.
 */
export async function transcribeVoice(audioPath: string): Promise<string> {
  let wavPath: string | undefined
  try {
    wavPath = await transcodeToWav(audioPath)
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, 35_000)
    try {
      const response = await fetch(ASR_SERVICE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioPath: wavPath }),
        signal: controller.signal,
      })
      if (!response.ok) return ''
      const payload = await response.json() as { text?: unknown }
      return typeof payload.text === 'string' ? payload.text : ''
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return ''
  } finally {
    if (wavPath !== undefined) await unlink(wavPath).catch(() => {})
  }
}

/** Transcode any container ffmpeg decodes to 16 kHz mono PCM WAV in the temp dir. */
function transcodeToWav(inputPath: string): Promise<string> {
  const wavPath = join(process.env.TEMP ?? '/tmp', `dsh-asr-${randomUUID()}.wav`)
  return new Promise((resolveWav, reject) => {
    const child = spawn(FFMPEG_BIN, [
      '-i', inputPath,
      '-ar', '16000', '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-y', wavPath,
    ], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('ffmpeg transcode timed out.'))
    }, 30_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveWav(wavPath)
      else reject(new Error(`ffmpeg exited with code ${code ?? 'null'}.`))
    })
  })
}

export interface SynthesizedVoice {
  mediaType: string
  data: Uint8Array
  durationMs?: number
}

/**
 * Synthesize reply voice through self-contained engines（TTS 独立化，不依赖 agents-to-im）：
 *  - auto/edge：微软 Edge TTS（免费无 key，WebSocket，开箱即用）
 *  - xiaomi：小米 MiMo TTS（HTTP 直连，需 TTS_XIAOMI_KEY 环境变量；文本 (唱歌) 标签触发唱歌）
 *  - local：本地 TTS 命令（DSH_LOCAL_TTS_CMD，文本作末参，stdout 输出音频）
 * 输出统一转 mp3（浏览器全兼容）。Never throws — returns null on failure.
 * @param text - reply text to speak.
 * @param provider - engine override (auto/edge/xiaomi/local; unknown falls back to edge).
 * @returns encoded audio, or null when synthesis or reading failed.
 */
export async function synthesizeReplyVoice(text: string, provider?: string): Promise<SynthesizedVoice | null> {
  const speak = stripMarkdown(text)
  const engine = provider ?? 'auto'
  try {
    if (engine === 'xiaomi') return await synthesizeXiaomiVoice(speak)
    if (engine === 'local') return await synthesizeLocalVoice(speak)
    // [本地改造 2026-08-17] 默认（auto）优先小米 MiMo（用户配置），key 缺失/合成失败时降级微软 edge
    if (engine === 'auto') {
      const xiaomi = await synthesizeXiaomiVoice(speak)
      if (xiaomi !== null) return xiaomi
    }
    return await synthesizeEdgeVoice(speak)
  } catch {
    return null
  }
}

/** 微软 Edge TTS（免费）：输出即 mp3，无需转码。 */
async function synthesizeEdgeVoice(text: string): Promise<SynthesizedVoice | null> {
  const voice = process.env.TTS_EDGE_VOICE ?? 'zh-CN-XiaoxiaoNeural'
  const mp3 = await edgeTts(text, voice)
  return toMp3(new Uint8Array(mp3), 'audio/mpeg')
}

/** 小米 MiMo TTS：HTTP 直连 api.xiaomimimo.com（key/音色从环境变量读，不碰外部配置文件）。 */
async function synthesizeXiaomiVoice(text: string): Promise<SynthesizedVoice | null> {
  const apiKey = process.env.TTS_XIAOMI_KEY ?? ''
  // [tts-debug] 定位小米失败：打印 key 是否存在 + HTTP 状态
  console.error(`[tts-debug] xiaomi key=${apiKey === '' ? 'MISSING' : 'present'} env=${Object.keys(process.env).filter(k => /TTS|XIAOMI/i.test(k)).join(',') || 'none'}`)
  if (apiKey === '') return null
  const baseUrl = process.env.TTS_XIAOMI_BASE_URL ?? 'https://api.xiaomimimo.com/v1'
  const voice = process.env.TTS_XIAOMI_VOICE ?? 'mimo_default'
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages: [
        { role: 'user', content: '把下面的文字转成语音' },
        { role: 'assistant', content: text },
      ],
      max_tokens: 8192,
      speed: 1.0,
      voice,
      audio: { format: 'wav' },
    }),
  })
  console.error(`[tts-debug] xiaomi http=${response.status}`)
  if (!response.ok) return null
  const payload = await response.json() as { choices?: Array<{ message?: { audio?: { data?: unknown } } }> }
  const data = payload.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || data.length < 100) return null
  return toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
}

/** 本地 TTS 命令（可插拔）：spawn DSH_LOCAL_TTS_CMD，文本作末参，stdout 收音频字节。 */
async function synthesizeLocalVoice(text: string): Promise<SynthesizedVoice | null> {
  const command = process.env.DSH_LOCAL_TTS_CMD ?? ''
  if (command === '') return null
  const parts = command.split(/\s+/)
  const bin = parts[0]
  if (bin === undefined) return null
  const rest = parts.slice(1)
  const audio = execFileSync(bin, [...rest, text], {
    windowsHide: true,
    encoding: 'buffer',
    timeout: 60_000,
  }) as Buffer
  return toMp3(new Uint8Array(audio), 'audio/mpeg')
}

/** 统一转 mp3：已是 mp3 直接返回；wav/其他容器用 ffmpeg 转（失败保留原格式）。 */
async function toMp3(data: Uint8Array, declared: string): Promise<SynthesizedVoice | null> {
  const isMp3 = data.length > 2 && data[0] === 0xFF && ((data[1] ?? 0) & 0xE0) === 0xE0
  let finalData = data
  let mediaType = declared
  if (!isMp3) {
    const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-tts-in-${randomUUID()}.wav`)
    const mp3Path = join(process.env.TEMP ?? '/tmp', `dsh-tts-${randomUUID()}.mp3`)
    await writeFile(tmpIn, data)
    try {
      execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-c:a', 'libmp3lame', '-b:a', '128k', mp3Path], {
        windowsHide: true, stdio: 'ignore', timeout: 30_000,
      })
      finalData = new Uint8Array(await readFile(mp3Path))
      mediaType = 'audio/mpeg'
    } catch {
      // 转码失败保留原容器（部分浏览器仍可播）。
    } finally {
      await unlink(tmpIn).catch(() => {})
      await unlink(mp3Path).catch(() => {})
    }
  }
  const durationMs = estimateAudioDurationMs(finalData)
  return {
    mediaType,
    data: finalData,
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

/** True when the leading bytes are an Ogg container (OggS magic). */
function looksLikeOgg(data: Uint8Array): boolean {
  return data.length >= 4
    && data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53 // 'OggS'
}

/**
 * [本地改造 2026-08-16] Strip Markdown syntax for TTS reading: headings, bold/
 * italic markers, inline code, links, tables, lists, and dividers become plain
 * readable text. Multi-line output is joined with spaces so the engine speaks
 * it fluently.
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')            // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')                  // inline code
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')      // links: keep label
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')     // images: keep alt
    .replace(/^#{1,6}\s*/gm, '')                  // ATX headings
    .replace(/^>+\s*/gm, '')                      // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '')                // list bullets
    .replace(/^\s*\d+[.)]\s+/gm, '')              // numbered lists
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')      // table separator rows (| --- | --- |)
    .replace(/^[-*_]{3,}\s*$/gm, '')              // horizontal rules
    .replace(/\|/g, ' ')                          // table pipes
    .replace(/\*\*([^*]+)\*\*/g, '$1')            // bold
    .replace(/\*([^*]+)\*/g, '$1')                // italic
    .replace(/__([^_]+)__/g, '$1')                // bold underscore
    .replace(/_([^_]+)_/g, '$1')                  // italic underscore
    .replace(/~~([^~]+)~~/g, '$1')                // strikethrough
    .replace(/^\s*[-*_]\s*$/gm, '')               // lone dash rows
    .replace(/\s*\n\s*/g, ' ')                    // newlines → space (fluent speech)
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Approximate audio duration for the reply pill. ffprobe is authoritative when
 * available (any container); otherwise falls back to a container-aware byte
 * estimate. Exact decode is overkill here — a second count is enough.
 * @param data - encoded audio bytes.
 * @param path - absolute produced-file path (ffprobe input).
 * @returns estimated duration in ms, or undefined when unreadable.
 */
function estimateAudioDurationMs(data: Uint8Array, path?: string): number | undefined {
  if (path !== undefined) {
    try {
      const ffprobe = process.env.DSH_VOICE_FFPROBE_BIN
        ?? 'C:\\Users\\oadan\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffprobe.exe'
      const out = execFileSync(ffprobe, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', path,
      ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
      const seconds = Number.parseFloat(out)
      if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
    } catch {
      // ffprobe unavailable or failed; fall through to the byte estimate.
    }
  }
  if (looksLikeOgg(data)) {
    // Ogg/Opus at the standard 48 kHz; a 12-byte frame carries 20ms (i.e. 600
    // bytes/s) — the bitrate heuristic below would grossly overestimate, so
    // give a rough constant bitrate guess instead.
    const kbps = 48
    return Math.round(data.length / (kbps * 1000 / 8) * 1000)
  }
  // MP3: skip a leading ID3v2 tag (its binary metadata can fake a frame sync),
  // then use the first real frame's bitrate.
  let offset = 0
  if (data.length >= 10 && (data[0] ?? 0) === 0x49 && (data[1] ?? 0) === 0x44 && (data[2] ?? 0) === 0x33 // 'ID3'
    && ((data[3] ?? 0) & 0xFF) < 0xFF && ((data[4] ?? 0) & 0xFF) < 0xFF) {
    const size = (((data[6] ?? 0) & 0x7F) << 21) | (((data[7] ?? 0) & 0x7F) << 14)
      | (((data[8] ?? 0) & 0x7F) << 7) | ((data[9] ?? 0) & 0x7F)
    offset = 10 + size
  }
  while (offset + 4 <= data.length) {
    const sync = ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0)
    if ((sync & 0xFFE0) === 0xFFE0) {
      const bitrateIndex = ((data[offset + 2] ?? 0) >>> 4) & 0x0F
      const sampleRateIndex = ((data[offset + 2] ?? 0) >>> 2) & 0x03
      if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined
      const bitrates = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      const kbps = bitrates[bitrateIndex - 1] ?? 128
      return Math.round((data.length - offset) / (kbps * 1000 / 8) * 1000)
    }
    offset += 1
  }
  return undefined
}
