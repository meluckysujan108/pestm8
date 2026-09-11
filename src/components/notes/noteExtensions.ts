import { mergeAttributes } from '@tiptap/core'
import { Document } from '@tiptap/extension-document'
import { Mention } from '@tiptap/extension-mention'
import { Placeholder } from '@tiptap/extension-placeholder'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { StarterKit } from '@tiptap/starter-kit'
import type { AnyExtension } from '@tiptap/core'
import type { MentionOptions } from '@tiptap/extension-mention'
import type { SuggestionOptions } from '@tiptap/suggestion'
import type { MentionItem } from './MentionList'

/** The first block is always the title, the way the phone's Notes app works. */
const NoteDocument = Document.extend({ content: 'heading block+' })

/**
 * A teammate pill. The member's colour travels in the document so the pill
 * paints correctly for every reader without a lookup; the server only ever
 * reads `id` (convex/lib/richText.ts).
 */
const TeamMention = Mention.extend<MentionOptions<MentionItem, MentionItem>>({
  addAttributes() {
    return {
      ...this.parent?.(),
      colour: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-colour'),
        renderHTML: (attrs) => (attrs.colour ? { 'data-colour': attrs.colour } : {}),
      },
    }
  },
})

export function noteExtensions(
  suggestion: Omit<SuggestionOptions<MentionItem, MentionItem>, 'editor'>,
): Array<AnyExtension> {
  return [
    NoteDocument,
    StarterKit.configure({
      document: false,
      heading: { levels: [1] },
      codeBlock: false,
      blockquote: false,
      horizontalRule: false,
      // Without this the trailing node defaults to the document's first
      // allowed type — a heading — and every body edit grows a spare title.
      trailingNode: { node: 'paragraph' },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({
      // "Title" stays visible while the body has focus, but the body prompt
      // only follows the caret — a template's deliberate blank lines are
      // not "empty notes".
      showOnlyCurrent: false,
      placeholder: ({ node, pos, hasAnchor }) =>
        node.type.name === 'heading' && pos === 0
          ? 'Title'
          : hasAnchor
            ? 'Start writing…'
            : '',
    }),
    TeamMention.configure({
      deleteTriggerWithBackspace: true,
      renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
      renderHTML: ({ node, options }) => [
        'span',
        mergeAttributes(options.HTMLAttributes, {
          class: 'mention',
          'data-type': 'mention',
          'data-id': node.attrs.id,
          style: node.attrs.colour ? `--mention-colour:${node.attrs.colour}` : undefined,
        }),
        `@${node.attrs.label ?? node.attrs.id}`,
      ],
      suggestion,
    }),
  ]
}
