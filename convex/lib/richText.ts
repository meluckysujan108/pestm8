/**
 * Pure helpers over a Tiptap/ProseMirror JSON document. The editor owns the
 * document; these only READ it to derive the list/search metadata stored on
 * `notes`, so a mismatch here can never corrupt a note — only its preview.
 *
 * Mirrored by `src/lib/notesContent.ts` for optimistic previews on the
 * client, the same Convex/client split `reportTemplates` already uses.
 */
export type PmNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: Array<PmNode>
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
  text?: string
}

const PREVIEW_CHARS = 140
const PLAIN_TEXT_CHARS = 100_000

export function walk(node: PmNode, visit: (node: PmNode) => void): void {
  visit(node)
  for (const child of node.content ?? []) walk(child, visit)
}

/** Inline text of a node; block boundaries become newlines. */
export function textOf(node: PmNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'mention') {
    const label = node.attrs?.label
    return typeof label === 'string' ? `@${label}` : ''
  }
  const inner = (node.content ?? []).map(textOf)
  return isBlock(node) ? inner.join('') + '\n' : inner.join('')
}

function isBlock(node: PmNode): boolean {
  return (
    node.type === 'paragraph' ||
    node.type === 'heading' ||
    node.type === 'taskItem' ||
    node.type === 'listItem' ||
    node.type === 'blockquote' ||
    node.type === 'codeBlock'
  )
}

export type DerivedNoteFields = {
  title: string
  preview: string
  plainText: string
  checklistTotal: number
  checklistDone: number
  mentionIds: Array<string>
}

export function deriveNoteFields(doc: PmNode): DerivedNoteFields {
  const blocks = doc.content ?? []
  const first = blocks.at(0)

  const firstText = first ? collapse(textOf(first)) : ''
  // The editor forces a heading as the first block, so this is the title.
  // Anything else (a migrated plain-text note) still reads its first line.
  const isTitled = first?.type === 'heading'
  const title = isTitled ? firstText : firstLine(firstText)
  const bodyBlocks = isTitled ? blocks.slice(1) : blocks

  const body = bodyBlocks.map(textOf).join('')
  const preview = collapse(body).slice(0, PREVIEW_CHARS)
  const plainText = `${title}\n${body}`.slice(0, PLAIN_TEXT_CHARS)

  let checklistTotal = 0
  let checklistDone = 0
  const mentionIds = new Set<string>()
  walk(doc, (node) => {
    if (node.type === 'taskItem') {
      checklistTotal += 1
      if (node.attrs?.checked === true) checklistDone += 1
    } else if (node.type === 'mention' && typeof node.attrs?.id === 'string') {
      mentionIds.add(node.attrs.id)
    }
  })

  return {
    title,
    preview,
    plainText,
    checklistTotal,
    checklistDone,
    mentionIds: [...mentionIds],
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function firstLine(s: string): string {
  return s.split('\n')[0]?.trim() ?? ''
}

/** A plain string as a document: first line becomes the title heading. */
export function docFromPlainText(text: string): PmNode {
  const [head = '', ...lines] = text.split('\n')
  return {
    type: 'doc',
    content: [
      heading(head.trim()),
      ...lines.map((line) => paragraph(line)),
    ],
  }
}

export function heading(text: string): PmNode {
  return {
    type: 'heading',
    attrs: { level: 1 },
    content: text ? [{ type: 'text', text }] : undefined,
  }
}

export function paragraph(text: string): PmNode {
  return {
    type: 'paragraph',
    content: text ? [{ type: 'text', text }] : undefined,
  }
}

export function boldParagraph(text: string): PmNode {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text, marks: [{ type: 'bold' }] }],
  }
}

export function taskList(items: Array<string>): PmNode {
  return {
    type: 'taskList',
    content: items.map((text) => ({
      type: 'taskItem',
      attrs: { checked: false },
      content: [paragraph(text)],
    })),
  }
}

export function emptyDoc(): PmNode {
  return { type: 'doc', content: [heading(''), paragraph('')] }
}
