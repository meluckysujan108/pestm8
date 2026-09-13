import type {
  RichBlock,
  RichDoc,
  RichMark,
  RichText as RichTextNode,
} from '#/lib/reportTemplates'

/**
 * The on-screen painter for `RichDoc` — the warranty pages, the AS 3660.2
 * terms, the IMPORTANT disclaimers.
 *
 * Its PDF twin lives in `pdf/RichTextPdf.tsx`. Two painters over one model, the
 * same arrangement `present()` already enforces for field values, so the terms
 * a client reads on screen and the terms they read in the attachment cannot
 * drift apart.
 */

const MARK_CLASS: Record<RichMark, string> = {
  bold: 'font-semibold',
  redText: 'text-red font-semibold',
  caps: 'uppercase',
}

function Inline({ nodes }: { nodes: Array<RichTextNode> }) {
  return (
    <>
      {nodes.map((node, index) => {
        const className = (node.marks ?? [])
          .map((mark) => MARK_CLASS[mark])
          .join(' ')
        return className ? (
          <span key={index} className={className}>
            {node.text}
          </span>
        ) : (
          <span key={index}>{node.text}</span>
        )
      })}
    </>
  )
}

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
  1: 'text-title3 font-semibold text-ink mt-4 first:mt-0',
  2: 'font-semibold mt-3 first:mt-0',
  3: 'font-semibold mt-2.5 first:mt-0',
}

function Block({ block }: { block: RichBlock }) {
  switch (block.type) {
    case 'heading':
      return (
        <p className={HEADING_CLASS[block.level]}>
          <Inline nodes={block.content} />
        </p>
      )

    case 'paragraph':
      return (
        <p className="mt-2 first:mt-0">
          <Inline nodes={block.content} />
        </p>
      )

    case 'bulletList':
      return (
        <ul className="mt-2 flex flex-col gap-1">
          {block.content.map((item, index) => (
            <li key={index} className="flex gap-2">
              <span aria-hidden className="text-muted">
                •
              </span>
              <span className="flex-1">
                <Blocks blocks={item.content} />
              </span>
            </li>
          ))}
        </ul>
      )

    case 'definitionList':
      return (
        <dl className="mt-2 flex flex-col gap-2">
          {block.content.map((item, index) => (
            <div key={index}>
              <dt className="font-semibold">{item.term}</dt>
              <dd>
                <Blocks blocks={item.content} />
              </dd>
            </div>
          ))}
        </dl>
      )

    default: {
      // A new block type must be paintable on both surfaces before it ships.
      const _exhaustive: never = block
      void _exhaustive
      return null
    }
  }
}

function Blocks({ blocks }: { blocks: Array<RichBlock> }) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  )
}

export function RichTextView({
  doc,
  className,
}: {
  doc: RichDoc
  className?: string
}) {
  return (
    <div className={className}>
      <Blocks blocks={doc.content} />
    </div>
  )
}

/** Plain text of a `RichDoc` — for search text, previews and alt text. */
export function richDocToPlainText(doc: RichDoc): string {
  const out: Array<string> = []
  const walk = (blocks: Array<RichBlock>) => {
    for (const block of blocks) {
      if (block.type === 'heading' || block.type === 'paragraph') {
        out.push(block.content.map((n) => n.text).join(''))
      } else if (block.type === 'bulletList') {
        for (const item of block.content) walk(item.content)
      } else {
        for (const item of block.content) {
          out.push(item.term)
          walk(item.content)
        }
      }
    }
  }
  walk(doc.content)
  return out.join('\n')
}
