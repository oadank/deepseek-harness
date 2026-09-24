/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock, ImageBlock, LlmImageRequestBudget } from './types.ts'
import type { RequestMessage } from './types.ts'
import type { Message } from './message.ts'
import type {
  AttachmentStore, FileAttachmentRef, ImageAttachmentRef, ImageMediaType, RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Execution-world path that model tools can use to read one normalized attachment. */
export interface ImageAttachmentAccess {
  /** Absolute path to immutable normalized bytes; callers must treat it as read-only. */
  readonlyPath: string
}

/**
 * Resolve current execution-world access for one durable image reference.
 * @param ref - durable normalized attachment reference.
 * @returns a read-only execution-world path, or undefined when unavailable.
 */
export type ImageAttachmentAccessResolver = (ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined

/**
 * Bridge one attachment provider's host object location into the mounted
 * tool execution world. The consumer supplies the current filesystem
 * provider's mapping without making attachment or LLM definitions depend on it.
 * @param attachments - provider that owns the normalized attachment object.
 * @param mapHostPath - map one absolute host path into the current tool execution world.
 * @param ref - durable normalized attachment reference.
 * @returns a read-only execution-world path, or undefined when either provider exposes no mapping.
 * @throws an attachment error when the durable reference is invalid.
 */
export function resolveImageAttachmentAccess(
  attachments: AttachmentStore,
  mapHostPath: (hostPath: string) => string | undefined,
  ref: ImageAttachmentRef,
): ImageAttachmentAccess | undefined {
  const hostPath = attachments.imageHostPath(ref)
  if (hostPath === undefined) return undefined
  const readonlyPath = mapHostPath(hostPath)
  return readonlyPath === undefined ? undefined : { readonlyPath }
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function imageIdentity(ref: ImageAttachmentRef): string {
  return ref.name === undefined
    ? String(ref.attachmentId)
    : `${quoted(ref.name)} (${ref.attachmentId})`
}

function extension(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return assertNever(mediaType, 'image extension')
  }
}

function normalizedAccessText(ref: ImageAttachmentRef, access: ImageAttachmentAccess): string {
  return ` Normalized copy (read-only; may be resized or re-encoded): ${quoted(access.readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}).`
    + ' Source dimensions, format, and byte size may differ.'
    + ` Copy to a writable path ending in ${extension(ref.mediaType)} before editing.`
}

/**
 * Stable text shown to a model that cannot accept one durable image reference.
 * @param ref - durable normalized attachment omitted from the request.
 * @returns deterministic text-only placeholder.
 */
/** [本地改造 2026-09-10] 解析 DSH 附件主目录（nssm 场景 env 可能缺项，逐级回落）。 */
function dshHomeDir(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  const dsh = env?.DSH_HOME
  if (dsh !== undefined && dsh.length > 0) return dsh.replace(/[\/]+$/, '')
  const up = env?.USERPROFILE ?? env?.HOME
  return up !== undefined && up.length > 0 ? up.replace(/[\/]+$/, '') + '/.dsh' : ''
}

export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const full = String(ref.attachmentId)
  const hex = full.startsWith('sha256:') ? full.slice('sha256:'.length) : full
  const digest = hex.slice(0, 8)
  const home = dshHomeDir()
  const objectPath = home !== '' && hex.length === 64
    ? `${home}/attachments/v1/objects/${hex.slice(0, 2)}/${hex}`
    : undefined
  const head = `[image omitted because this model accepts text only; attachment sha256:${digest}`
  return objectPath === undefined
    ? `${head}]`
    : `${head}; 本地文件路径 ${objectPath}（无扩展名内容寻址对象，直接以 image_path 参数调用 look_image 工具识图：默认 describe=看图描述；要求像素级反推用 task="reverse"；提取图中文字用 task="text"。路径可能无扩展名，直接 readFile 即可。）]`
}

/**
 * Stable model-facing handle for one exact request image. Identity comes from
 * the occurrence's own durable reference: request versions are prepared per
 * attachment id, so one shared version may serve occurrences whose display
 * names differ.
 * @param ref - the occurrence's durable normalized attachment.
 * @param version - exact request-image dimensions shown beside the text.
 * @param access - optional path resolved for the current tool execution world.
 * @returns attachment handle and request-image dimensions.
 */
export function requestImageHandleText(
  ref: ImageAttachmentRef,
  version: Pick<RequestImageAttachment, 'width' | 'height'>,
  access?: ImageAttachmentAccess,
): string {
  const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`
  return access === undefined
    ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
    : preview + normalizedAccessText(ref, access)
}

/**
 * Stable per-image placeholder for a request-limit omission.
 * @param ref - durable normalized attachment omitted from this request.
 * @param access - optional provider-resolved path for model tools.
 * @returns identity, normalized metadata, and the available recovery path.
 */
export function offloadedImageText(
  ref: ImageAttachmentRef,
  access?: ImageAttachmentAccess,
): string {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  if (access === undefined) {
    return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`
  }
  return `[${identity}${normalizedAccessText(ref, access)}]`
}

/**
 * True when typed model content contains an image block. This is the one image
 * walk shared by every image policy (capability gating, text-only
 * serialization, compaction survey), so a consumer cannot silently diverge.
 * @param content - typed model content blocks.
 * @returns whether any block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image')
}

/**
 * True when typed model content contains a file block.
 * Reads current content on every call without retaining scan results.
 * @param content - typed model content blocks.
 * @returns whether any block is a file.
 */
export function contentHasFile(content: readonly ContentBlock[]): boolean {
  for (const block of content) {
    if (block.type === 'file') return true
  }
  return false
}

/**
 * Stable model-facing handle for one durable file reference: the address of
 * the verbatim stored copy and the instruction to read it on demand. This is
 * the only representation a provider ever receives for a file.
 * @param ref - durable verbatim file reference.
 * @param readonlyPath - execution-world path of the stored copy, when resolvable.
 * @returns deterministic handle text naming the file, its size, and its address.
 */
export function fileHandleText(ref: FileAttachmentRef, readonlyPath: string | undefined): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`
  if (readonlyPath === undefined) {
    return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`
  }
  return `[${identity}: verbatim read-only copy saved at ${quoted(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`
}

/** Replace every file occurrence with handle text. */
function replaceFilesWithHandles(
  blocks: readonly ContentBlock[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'file') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: fileHandleText(block.attachment, resolvePath(block.attachment)) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/** [本地改造 2026-08-16 · 0.1.7 重落] 语音对象的内容寻址读取路径（与 attachment 存储布局一致）。 */
function voiceObjectPath(voiceId: string): string {
  const hex = voiceId.startsWith('sha256:') ? voiceId.slice('sha256:'.length) : voiceId
  if (hex.length === 0) return '(unknown)'
  const home = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}/.dsh` : process.env.HOME ? `${process.env.HOME}/.dsh` : '')
  return home.length === 0 ? '(unknown)' : `${home}/attachments/v1/objects/${hex.slice(0, 2)}/${hex}`
}

/** [本地改造 2026-08-16] 一条语音换成模型可读文本：有识别结果直给文本，没有则给本地路径让 agent 走本机 ASR。 */
export function voiceHandleText(attachment: { voiceId: string; durationMs?: number | undefined; transcript?: string | undefined }): string {
  const duration = typeof attachment.durationMs === 'number' ? `（时长 ${Math.round(attachment.durationMs / 1000)} 秒）` : ''
  const transcript = typeof attachment.transcript === 'string' && attachment.transcript.length > 0 ? attachment.transcript : undefined
  if (transcript !== undefined) return `[用户发送了一条语音${duration}，识别内容：${transcript}]`
  return `[用户发送了一条语音${duration}，本地语音文件路径: ${voiceObjectPath(attachment.voiceId)}。请调用本机语音识别服务转写后再回答；路径可能无扩展名，直接读取即可。]`
}

/**
 * Project voice content into handle text for every model route, mirroring
 * {@link projectFilesToText}: no provider represents voice blocks natively, so
 * request assembly must clear them before dispatch.
 * @param messages - complete request inputs.
 * @returns original inputs without voices, otherwise copies with handle text.
 */
export function projectVoicesToText(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  if (!messages.some(message => message.content.some(block => block.type === 'voice'))) return messages
  return messages.map((message): RequestMessage => {
    if (!message.content.some(block => block.type === 'voice')) return message
    // Tool results are their own messages in 0.1.7, so this one pass covers them.
    return { ...message, content: message.content.flatMap((block): ContentBlock[] => (block.type === 'voice'
      ? [{ type: 'text', text: voiceHandleText(block.attachment) }]
      : [block])) }
  })
}

/**
 * Project request file content into deterministic handle text for every model
 * route. Unlike images, no provider receives file blocks natively, so this
 * projection is unconditional in request assembly.
 * @param messages - complete request history.
 * @param resolvePath - resolve one reference's current execution-world read path.
 * @returns the original list without files, otherwise shallow message copies with handle text.
 */
export function projectFilesToText(
  messages: readonly Message[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly Message[]
/**
 * Project file content in mixed durable and request-only inputs.
 * @param messages - complete request inputs.
 * @param resolvePath - resolve a reference's execution-world read path.
 * @returns original inputs without files, otherwise copies with handle text.
 */
export function projectFilesToText(
  messages: readonly RequestMessage[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly RequestMessage[]
export function projectFilesToText(
  messages: readonly RequestMessage[],
  resolvePath: (ref: FileAttachmentRef) => string | undefined,
): readonly RequestMessage[] {
  if (!messages.some(message => contentHasFile(message.content))) return messages
  return messages.map((message) => {
    const content = replaceFilesWithHandles(message.content, resolvePath)
    return content === message.content ? message : { ...message, content }
  })
}

/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Visit every image occurrence of typed content in message order.
 * @param content - typed model content blocks.
 * @param visit - called once per occurrence.
 */
function visitImageBlocks(content: readonly ContentBlock[], visit: (block: ImageBlock) => void): void {
  for (const block of content) {
    if (block.type === 'image') visit(block)
  }
}

/** Replace every offloaded occurrence with its placeholder. */
function replaceOffloadedImages(
  blocks: readonly ContentBlock[],
  placeholder: (ref: ImageAttachmentRef) => string,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image' && block.offloaded === true) {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: placeholder(block.attachment) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Project the surface's offloaded occurrences into deterministic text for one
 * request. The offloaded set is a durable surface fact, so every route sends
 * the same set; only the placeholder text is route-owned.
 * @param messages - derived request history.
 * @param placeholder - build the model-visible replacement for one offloaded attachment.
 * @returns the original list when nothing is offloaded, otherwise shallow message copies with placeholders.
 */
export function projectOffloadedImages(
  messages: readonly Message[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly Message[]
/**
 * Project offloaded images in mixed durable and request-only inputs.
 * @param messages - complete request inputs.
 * @param placeholder - replacement text for an offloaded attachment.
 * @returns original messages or shallow copies with placeholders.
 */
export function projectOffloadedImages(
  messages: readonly RequestMessage[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly RequestMessage[]
export function projectOffloadedImages(
  messages: readonly RequestMessage[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly RequestMessage[] {
  return messages.map((message) => {
    const content = replaceOffloadedImages(message.content, placeholder)
    return content === message.content ? message : { ...message, content }
  })
}

/**
 * Number of oldest retained image occurrences one route budget removes, in
 * whole count and byte quanta, once the budget is exceeded. The result depends
 * only on the represented lengths, so every route names the count the same
 * way.
 * @param lengths - represented byte length of every retained occurrence, oldest first.
 * @param budget - count/byte budgets and removal quanta; unbounded when absent.
 * @returns how many leading occurrences to offload.
 */
function offloadedImagePrefixCount(
  lengths: readonly number[],
  budget: Pick<LlmImageRequestBudget, 'maxImages' | 'maxBytes' | 'countQuantum' | 'byteQuantum'>,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excessCount = budget.maxImages === undefined ? 0 : Math.max(0, lengths.length - budget.maxImages)
  const excessBytes = budget.maxBytes === undefined ? 0 : Math.max(0, total - budget.maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0
  const countQuantum = budget.countQuantum ?? 1
  const byteQuantum = budget.byteQuantum ?? 1
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0
  let removedBytes = 0
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += imageBytes
    count += 1
  }
  return count
}

/**
 * Number of oldest retained occurrences a route must still offload before a
 * derived request fits its budget at the exact byte length the route sends;
 * zero when the request fits. A route fails with `IMAGE_OFFLOAD_REQUIRED`
 * carrying this count instead of offloading on its own.
 * @param messages - derived request history carrying the surface's `offloaded` marks.
 * @param budget - route representation, budgets, and removal quanta.
 * @param versionBytes - exact request-version byte length of one retained occurrence.
 * @returns how many more leading retained occurrences to offload.
 */
export function requiredImageOffload(
  messages: readonly RequestMessage[],
  budget: Pick<LlmImageRequestBudget, 'representation' | 'maxBytes' | 'maxImages' | 'byteQuantum' | 'countQuantum'>,
  versionBytes: (block: ImageBlock) => number,
): number {
  const lengths: number[] = []
  for (const message of messages) {
    visitImageBlocks(message.content, (block) => {
      if (block.offloaded === true) return
      const bytes = versionBytes(block)
      lengths.push(budget.representation === 'base64' ? base64Length(bytes) : bytes)
    })
  }
  return offloadedImagePrefixCount(lengths, budget)
}

/** Replace every image occurrence for a text-only model. */
function replaceImagesForTextModel(blocks: readonly ContentBlock[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: textOnlyImageText(block.attachment) })
      continue
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Project request image content into deterministic text for an exact text-only model.
 * @param messages - complete request history.
 * @returns the original list without images, otherwise shallow message copies with stable placeholders.
 */
export function projectImagesForTextModel(messages: readonly Message[]): readonly Message[]
/**
 * Project image content in mixed durable and request-only inputs for a text-only model.
 * @param messages - complete request inputs.
 * @returns original inputs without images, otherwise copies with stable placeholders.
 */
export function projectImagesForTextModel(messages: readonly RequestMessage[]): readonly RequestMessage[]
export function projectImagesForTextModel(messages: readonly RequestMessage[]): readonly RequestMessage[] {
  if (!messages.some(message => contentHasImage(message.content))) return messages
  return messages.map((message) => {
    const content = replaceImagesForTextModel(message.content)
    return content === message.content ? message : { ...message, content }
  })
}
