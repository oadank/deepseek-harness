/**
 * Multi-engine reply synthesis (edge / xiaomi / local command), mp3-first.
 * Ported from the retired apiproxy voice.ts into the edge-tts host package.
 * @module @deepseek-ai/dsh-host-edge-tts/synthesize
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_EDGE_TTS_VOICE, edgeTts } from './edge-tts.ts'

/** One synthesized reply audio buffer. */
export interface SynthesizedVoice {
  mediaType: string
  data: Uint8Array
  durationMs?: number | undefined
  transcript: string
}

/** Strip markdown noise so TTS speaks prose, not symbols. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => {
      const inner = m.match(/\[([^\]]*)\]/)?.[1]
      return inner ?? ' '
    })
    .replace(/^[#>\-\*\s]+/gmu, ' ')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const FFMPEG_BIN = process.env.DSH_VOICE_FFMPEG_BIN
  ?? (process.platform === 'win32' ? 'ffmpeg' : '/usr/bin/ffmpeg')

function estimateAudioDurationMs(data: Uint8Array): number | undefined {
  // MP3 CBR 48kbps ≈ 6000 bytes/s for audio-24khz-48kbitrate-mono.
  if (data.byteLength < 1200) return undefined
  return Math.round((data.byteLength / 6000) * 1000)
}

async function toMp3(data: Uint8Array, declared: string): Promise<{
  mediaType: string
  data: Uint8Array
  durationMs?: number | undefined
} | null> {
  const isMp3 = data.length > 2 && data[0] === 0xFF && ((data[1] ?? 0) & 0xE0) === 0xE0
  let finalData = data
  let mediaType = declared
  if (!isMp3) {
    const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-tts-in-${randomUUID()}.wav`)
    const mp3Path = join(process.env.TEMP ?? '/tmp', `dsh-tts-${randomUUID()}.mp3`)
    await writeFile(tmpIn, data)
    try {
      execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-c:a', 'libmp3lame', '-b:a', '128k', mp3Path], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 30_000,
      })
      finalData = new Uint8Array(await readFile(mp3Path))
      mediaType = 'audio/mpeg'
    } catch {
      // Keep the original container when ffmpeg is unavailable.
    } finally {
      await unlink(tmpIn).catch(() => {})
      await unlink(mp3Path).catch(() => {})
    }
  }
  return {
    mediaType,
    data: finalData,
    durationMs: estimateAudioDurationMs(finalData),
  }
}

async function synthesizeEdgeVoice(text: string): Promise<{
  mediaType: string
  data: Uint8Array
  durationMs?: number | undefined
} | null> {
  const voice = process.env.TTS_EDGE_VOICE ?? DEFAULT_EDGE_TTS_VOICE
  try {
    const mp3 = await edgeTts(text, voice)
    return toMp3(new Uint8Array(mp3), 'audio/mpeg')
  } catch {
    return null
  }
}

async function synthesizeXiaomiVoice(text: string): Promise<{
  mediaType: string
  data: Uint8Array
  durationMs?: number | undefined
} | null> {
  const apiKey = process.env.TTS_XIAOMI_KEY ?? ''
  if (apiKey === '') return null
  const baseUrl = process.env.TTS_XIAOMI_BASE_URL ?? 'https://api.xiaomimimo.com/v1'
  const voice = process.env.TTS_XIAOMI_VOICE ?? 'mimo_default'
  try {
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
    if (!response.ok) return null
    const payload = await response.json() as {
      choices?: Array<{ message?: { audio?: { data?: unknown } } }>
    }
    const data = payload.choices?.[0]?.message?.audio?.data
    if (typeof data !== 'string' || data.length < 100) return null
    return toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
  } catch {
    return null
  }
}

async function synthesizeLocalVoice(text: string): Promise<{
  mediaType: string
  data: Uint8Array
  durationMs?: number | undefined
} | null> {
  const command = process.env.DSH_LOCAL_TTS_CMD ?? ''
  if (command === '') return null
  const parts = command.split(/\s+/)
  const bin = parts[0]
  if (bin === undefined) return null
  try {
    const audio = execFileSync(bin, [...parts.slice(1), text], {
      windowsHide: true,
      encoding: 'buffer',
      timeout: 60_000,
    }) as Buffer
    return toMp3(new Uint8Array(audio), 'audio/mpeg')
  } catch {
    return null
  }
}

/**
 * Synthesize reply audio. auto prefers Xiaomi when configured, else Edge.
 * Never throws — returns null on failure.
 * @param text - reply text to speak.
 * @param provider - engine override (auto/edge/xiaomi/local).
 */
export async function synthesizeReplyVoice(
  text: string,
  provider?: string,
): Promise<SynthesizedVoice | null> {
  const speak = stripMarkdown(text)
  if (speak.length === 0) return null
  const engine = provider ?? 'auto'
  try {
    if (engine === 'xiaomi') {
      const x = await synthesizeXiaomiVoice(speak)
      return x === null ? null : { ...x, transcript: speak }
    }
    if (engine === 'local') {
      const l = await synthesizeLocalVoice(speak)
      return l === null ? null : { ...l, transcript: speak }
    }
    if (engine === 'auto') {
      const xiaomi = await synthesizeXiaomiVoice(speak)
      if (xiaomi !== null) return { ...xiaomi, transcript: speak }
    }
    const edge = await synthesizeEdgeVoice(speak)
    return edge === null ? null : { ...edge, transcript: speak }
  } catch {
    return null
  }
}
