import { ReactRenderer } from '@tiptap/react'
import { MentionList } from './MentionList'
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'
import type { MentionItem, MentionListProps, MentionListRef } from './MentionList'

type Props = SuggestionProps<MentionItem, MentionItem>

/**
 * `getMembers` is read on every keystroke rather than captured once, so the
 * roster a note was opened with never goes stale while it stays open.
 */
export function mentionSuggestion(
  getMembers: () => Array<MentionItem>,
): Omit<SuggestionOptions<MentionItem, MentionItem>, 'editor'> {
  return {
    char: '@',
    // Inside a vaul sheet the body has pointer-events:none and sits under
    // the sheet's overlay, so the list must live inside the sheet itself.
    // No sheet on the page → the plugin falls back to document.body.
    container: '[data-vaul-drawer]',
    items: ({ query }) => {
      const q = query.trim().toLowerCase()
      return getMembers()
        .filter((m) => !q || m.label.toLowerCase().includes(q))
        .slice(0, 8)
    },
    // Insertion is left to the extension's default command: it already
    // handles the trailing space and the WebKit selection quirk, and the
    // schema keeps only id/label/colour from the picked item.
    render: () => {
      let component: ReactRenderer<MentionListRef, MentionListProps> | null = null
      let unmount: (() => void) | null = null

      const toListProps = (props: Props): MentionListProps => ({
        items: props.items,
        command: props.command,
      })

      return {
        onStart: (props) => {
          component = new ReactRenderer(MentionList, {
            props: toListProps(props),
            editor: props.editor,
          })
          unmount = props.mount(component.element)
        },
        onUpdate: (props) => component?.updateProps(toListProps(props)),
        onKeyDown: (props) => component?.ref?.onKeyDown(props) ?? false,
        onExit: () => {
          unmount?.()
          component?.destroy()
          component = null
          unmount = null
        },
      }
    },
  }
}
