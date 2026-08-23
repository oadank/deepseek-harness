/**
 * Durable image-object storage, mirroring the content-addressed attachment
 * layout below `DSH_HOME/attachments/v1`. [本地改造 2026-08-23] the agent can
 * send an image message (image/reply) by handing the host an absolute local
 * file path; the bytes are persisted sha256-addressed like user attachments,
 * and the frontend reads them back through the session.image RPC.
 * @module @deepseek-ai/dsh-host-apiproxy/image
 */

import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AttachmentId, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Maximum encoded bytes accepted for one image object. */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024

/** Absolute versioned storage root (same layout as the attachment backend). */
export function imageStorageRoot(configuredHome?: string): string {
  const home = configuredHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(join(home, 'attachments', 'v1'))
}

function objectPath(root: string, sha256: string): string {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

/**
 * Best-effort intrinsic dimensions from encoded image bytes (png/jpeg/gif/webp).
 * Returns a 1×1 fallback when the container is unrecognized or corrupt — callers
 * must never fail on this; the frontend infers real display size from the decoded
 * bitmap, and the RPC schema requires a strictly positive size.
 * @param data - encoded image bytes.
 * @returns intrinsic width and height in pixels.
 */
function readImageSize(data: Uint8Array): { width: number; height: number } {
  // Bounds-checked byte accessor: noUncheckedIndexedAccess makes Uint8Array
  // indexing return `number | undefined`. Callers guard every branch with a
  // length check, so an out-of-range read (which never happens in practice)
  // collapses to 0 rather than forcing a non-null assertion.
  const byte = (i: number): number => {
    const v = data[i]
    return v === undefined ? 0 : v
  }
  // PNG: IHDR width/height at byte offsets 16/20 (big-endian).
  if (data.length >= 24 && byte(0) === 0x89 && byte(1) === 0x50 && byte(2) === 0x4E && byte(3) === 0x47) {
    const width = (byte(16) << 24) | (byte(17) << 16) | (byte(18) << 8) | byte(19)
    const height = (byte(20) << 24) | (byte(21) << 16) | (byte(22) << 8) | byte(23)
    return { width: Math.max(1, width), height: Math.max(1, height) }
  }
  // GIF: width/height at offsets 6/8 (little-endian).
  if (data.length >= 10 && byte(0) === 0x47 && byte(1) === 0x49 && byte(2) === 0x46) {
    const width = byte(6) | (byte(7) << 8)
    const height = byte(8) | (byte(9) << 8)
    return { width: Math.max(1, width), height: Math.max(1, height) }
  }
  // JPEG: scan SOF markers (C0–CF, excluding C4/C8/CC) for height/width.
  if (data.length >= 4 && byte(0) === 0xFF && byte(1) === 0xD8) {
    let i = 2
    while (i + 9 < data.length) {
      if (byte(i) !== 0xFF) { i += 1; continue }
      const marker = byte(i + 1)
      if (marker === 0xD9 || marker === 0xDA) break // EOI/SOS: no further SOF
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        const height = (byte(i + 5) << 8) | byte(i + 6)
        const width = (byte(i + 7) << 8) | byte(i + 8)
        return { width: Math.max(1, width), height: Math.max(1, height) }
      }
      const len = (byte(i + 2) << 8) | byte(i + 3)
      i += 2 + len
    }
  }
  // WebP: RIFF....WEBP then VP8X / VP8 / VP8L.
  if (
    data.length >= 16
    && byte(0) === 0x52 && byte(1) === 0x49 && byte(2) === 0x46 && byte(3) === 0x46
    && byte(8) === 0x57 && byte(9) === 0x45 && byte(10) === 0x42 && byte(11) === 0x50
  ) {
    const fourcc = String.fromCharCode(byte(12), byte(13), byte(14), byte(15))
    if (fourcc === 'VP8X' && data.length >= 30) {
      const width = (byte(24) | (byte(25) << 8) | (byte(26) << 16)) + 1
      const height = (byte(27) | (byte(28) << 8) | (byte(29) << 16)) + 1
      return { width, height }
    }
    if (fourcc === 'VP8L' && data.length >= 25) {
      // VP8L lossless: 14-bit LE width/height at file offset 21, each +1.
      const v = byte(21) | (byte(22) << 8) | (byte(23) << 16) | (byte(24) << 24)
      const width = (v & 0x3FFF) + 1
      const height = ((v >> 14) & 0x3FFF) + 1
      return { width, height }
    }
    if (fourcc === 'VP8 ' && data.length >= 32) {
      // VP8 lossy keyframe: 14-bit LE width at offset 26, height at offset 29.
      const width = byte(26) | (byte(27) << 8) | ((byte(28) & 0x3F) << 16)
      const height = byte(29) | (byte(30) << 8) | ((byte(31) & 0x3F) << 16)
      return { width: Math.max(1, width), height: Math.max(1, height) }
    }
  }
  return { width: 1, height: 1 }
}

/** Resolve the absolute object path for one image reference. */
export function imageObjectPath(root: string, attachmentId: string): string {
  return objectPath(root, attachmentId.replace(/^sha256:/, ''))
}

/**
 * Store immutable image bytes below a versioned root, content-addressed by
 * sha256 exactly like user image attachments. A concurrent duplicate write
 * resolves to the existing object.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param data - encoded image bytes.
 * @param mediaType - declared image container format.
 * @returns durable content-addressed reference.
 */
export async function saveImageFile(
  root: string,
  data: Uint8Array,
  mediaType: ImageMediaType,
): Promise<ImageAttachmentRef> {
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image object exceeds the ${MAX_IMAGE_BYTES}-byte limit.`)
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
      throw new Error(`Unable to persist image object: ${String(error)}`, { cause: error })
    }
    // A duplicate sha256 target already exists; bytes are identical by construction.
  }
  let size: { width: number; height: number }
  try {
    size = readImageSize(data)
  } catch {
    size = { width: 1, height: 1 }
  }
  return {
    attachmentId: `sha256:${sha256}` as AttachmentId,
    mediaType,
    bytes: data.byteLength,
    width: size.width,
    height: size.height,
  }
}

/**
 * Read one content-addressed image object.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param ref - reference recorded in the session log.
 * @returns stored bytes and the reference.
 */
export async function readImageFile(
  root: string,
  ref: ImageAttachmentRef,
): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }> {
  const data = new Uint8Array(await readFile(imageObjectPath(root, ref.attachmentId)))
  return { ref, data }
}
