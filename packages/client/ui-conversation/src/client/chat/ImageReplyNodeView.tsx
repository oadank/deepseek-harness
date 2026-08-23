// ImageReplyNodeView: the assistant's sent image as its own durable chat row —
// a standalone image (click to enlarge), mirroring the user's image messages
// instead of being buried inside the text reply.

import { memo } from 'react'
import type { ChatNodeViewProps } from '../contract/slots.ts'

/** Assistant image-reply keyed Chat renderer: one standalone image. */
export const ImageReplyNodeView = memo(function ImageReplyNodeView({
  node, renderMessageImages,
}: ChatNodeViewProps<'image-reply'>) {
  const { image } = node.data
  return (
    <div data-image-reply>
      {renderMessageImages({ images: [{ attachment: image }], align: 'end' })}
    </div>
  )
})
