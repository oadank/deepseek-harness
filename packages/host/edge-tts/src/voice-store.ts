/**
 * Content-addressed durable voice objects under the attachment objects pool.
 * @module @deepseek-ai/dsh-host-edge-tts/voice-store
 */

import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Maximum encoded bytes accepted for one voice object. */
export const MAX_VOICE_BYTES = 25 * 1024 * 1024

/** Durable voice object reference recorded on session events. */
export interface VoiceObjectRef {
  readonly voiceId: string
  readonly mediaType: string
  readonly bytes: number
  readonly durationMs?: number | undefined
  readonly transcript?: string | undefined
}

/** Absolute versioned storage root (same layout as the attachment backend). */
export function voiceStorageRoot(configuredHome?: string): string {
  const home = configuredHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(join(home, 'attachments', 'v1'))
}

/** Resolve the absolute object path for one voice reference. */
export function voiceObjectPath(root: string, voiceId: string): string {
  const sha256 = voiceId.replace(/^sha256:/, '')
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error('invalid voiceId')
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

/**
 * Store immutable voice bytes content-addressed by sha256.
 * @returns durable content-addressed reference.
 */
export async function saveVoiceFile(
  root: string,
  data: Uint8Array,
  mediaType: string,
  durationMs?: number,
  transcript?: string,
): Promise<VoiceObjectRef> {
  if (data.byteLength > MAX_VOICE_BYTES) {
    throw new Error(`Voice object exceeds the ${MAX_VOICE_BYTES}-byte limit.`)
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const target = voiceObjectPath(root, `sha256:${sha256}`)
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
  }
  return {
    voiceId: `sha256:${sha256}`,
    mediaType,
    bytes: data.byteLength,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(transcript === undefined || transcript === '' ? {} : { transcript }),
  }
}

/** Read one content-addressed voice object. */
export async function readVoiceFile(
  root: string,
  ref: VoiceObjectRef,
): Promise<{ ref: VoiceObjectRef; data: Uint8Array }> {
  const data = new Uint8Array(await readFile(voiceObjectPath(root, ref.voiceId)))
  return { ref, data }
}
