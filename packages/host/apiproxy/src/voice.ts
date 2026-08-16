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
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import type { VoiceAttachmentRef, VoiceMediaType } from './api/sessions.ts'

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
    const timer = setTimeout(() => controller.abort(), 35_000)
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

/** agents-to-im TTS CLI entry; mp3 output is browser-universal. */
const TTS_CLI = process.env.DSH_TTS_CLI
  ?? 'C:\\D\\opt\\agents-to-im\\src\\feishu\\tts-cli.mjs'

export interface SynthesizedVoice {
  mediaType: string
  data: Uint8Array
  durationMs?: number
}

/**
 * Synthesize one reply through the local TTS engine (edge by default, or the
 * caller-chosen provider). Output is forced to mp3 via the `weixin` channel
 * mapping so any browser can play it. Never throws — returns null on failure.
 * @param text - reply text to speak.
 * @param provider - optional engine override (auto/edge/melo/matcha/xiaomi/wangwang/ali).
 * @returns encoded audio, or null when synthesis or reading failed.
 */
export async function synthesizeReplyVoice(text: string, provider?: string): Promise<SynthesizedVoice | null> {
  const outputDir = join(process.env.TEMP ?? '/tmp', 'agents-to-im-tts')
  const before = new Set<string>()
  for (const entry of await readdir(outputDir).catch(() => [])) before.add(entry)
  return new Promise<SynthesizedVoice | null>((resolveSynthesis) => {
    const args = [TTS_CLI, text]
    if (provider !== undefined && provider !== '' && provider !== 'auto') {
      args.push('--provider', provider)
    }
    const child = spawn(process.execPath, args, {
      windowsHide: true,
      env: { ...process.env, TTS_CHANNEL: 'weixin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', () => { /* engine diagnostics stay quiet */ })
    const timer = setTimeout(() => {
      child.kill()
      resolveSynthesis(null)
    }, 60_000)
    child.once('error', () => {
      clearTimeout(timer)
      resolveSynthesis(null)
    })
    child.once('close', async (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolveSynthesis(null)
        return
      }
      // The CLI prints the produced path on its last stdout line.
      const lines = stdout.trim().split('\n')
      const path = lines.at(-1)?.trim()
      if (path === undefined || path === '') {
        resolveSynthesis(null)
        return
      }
      try {
        let audioPath = path
        let produced: string | undefined
        const data = new Uint8Array(await readFile(audioPath))
        // [本地改造 2026-08-16] tts-cli 输出 Ogg/Opus（即使打印 MP3 中间产物）。
        // 统一转 mp3 再落盘：浏览器全兼容（含 iOS Safari），mediaType 恒为 audio/mpeg。
        if (looksLikeOgg(data)) {
          const mp3 = join(outputDir, `dsh-tts-${randomUUID()}.mp3`)
          try {
            execFileSync(FFMPEG_BIN, ['-y', '-i', audioPath, '-c:a', 'libmp3lame', '-b:a', '128k', mp3], {
              windowsHide: true, stdio: 'ignore', timeout: 30_000,
            })
            produced = mp3
            audioPath = mp3
          } catch {
            // 转码失败保留原 Opus（部分浏览器仍可播）；mediaType 按实际格式给。
          }
        }
        const finalData = new Uint8Array(await readFile(audioPath))
        const durationMs = estimateAudioDurationMs(finalData, audioPath)
        resolveSynthesis({
          mediaType: looksLikeOgg(finalData) ? 'audio/ogg' : 'audio/mpeg',
          data: finalData,
          ...(durationMs === undefined ? {} : { durationMs }),
        })
        if (produced !== undefined) await unlink(produced).catch(() => {})
      } catch {
        resolveSynthesis(null)
      } finally {
        // Remove the freshly produced artifacts (mp3 + any raw intermediates).
        const after = await readdir(outputDir).catch(() => [])
        for (const name of after) {
          if (!before.has(name)) await unlink(join(outputDir, name)).catch(() => {})
        }
      }
    })
  })
}

/** True when the leading bytes are an Ogg container (OggS magic). */
function looksLikeOgg(data: Uint8Array): boolean {
  return data.length >= 4
    && data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53 // 'OggS'
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
