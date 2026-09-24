// ImageReplyNodeView: assistant's sent image as its own durable chat row.
// [本地改造 2026-08-23 / 0.1.5 已迁移]

import { memo } from 'react'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ChatNodeViewProps } from '../contract/slots.ts'

/** Assistant image-reply keyed Chat renderer: one standalone image. */
export const ImageReplyNodeView = memo(function ImageReplyNodeView({
  node, renderMessageImages,
}: ChatNodeViewProps<'image-reply'>) {
  const { image } = node.data
  const attachment: ImageAttachmentRef = {
    attachmentId: image.attachmentId as AttachmentId,
    mediaType: image.mediaType as ImageAttachmentRef['mediaType'],
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
  }
  return (
    <div data-image-reply>
      {renderMessageImages({ images: [{ attachment }], align: 'start' })}
    </div>
  )
})
