import { useEffect, useState } from 'react'
import { useEditorState } from '@tiptap/react'
import { AtSign, Bold, Heading, Italic, List, ListChecks } from 'lucide-react'
import type { Editor } from '@tiptap/core'
import type { ReactNode } from 'react'

/**
 * On a phone this sits where the phone's Notes app puts its "Aa" row: pinned
 * just above the keyboard. `position: fixed` alone lands under the keyboard
 * on iOS, since the layout viewport does not shrink — so the bar tracks the
 * visual viewport instead. On desktop it is a plain row above the editor.
 */
export function FormatBar({
  editor,
  trailing,
  inline = false,
}: {
  editor: Editor | null
  trailing?: ReactNode
  /** A plain row in the flow (inside a sheet) instead of floating over the keyboard. */
  inline?: boolean
}) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            heading: e.isActive('heading'),
            // The first block is always the title, so "Title" is a no-op there.
            inTitle: e.state.selection.$from.index(0) === 0,
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            taskList: e.isActive('taskList'),
            bulletList: e.isActive('bulletList'),
          }
        : null,
  })
  const keyboardInset = useKeyboardInset()

  if (!editor) return null

  const button = (
    label: string,
    icon: ReactNode,
    on: boolean,
    run: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={`hold-target flex size-9 items-center justify-center rounded-lg transition active:scale-[.95] disabled:opacity-40 ${
        on ? 'bg-ink text-white' : 'text-ink-2 hover:bg-surface-2'
      }`}
    >
      {icon}
    </button>
  )

  // The suggestion plugin only opens after whitespace, so a tap mid-word
  // ("Ask|") gets the space typed for it.
  const startMention = () => {
    const before = editor.state.selection.$from.nodeBefore
    const needsSpace = before !== null && !(before.isText && /\s$/.test(before.text ?? ''))
    editor.chain().focus().insertContent(needsSpace ? ' @' : '@').run()
  }

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      style={!inline && keyboardInset > 0 ? { bottom: keyboardInset } : undefined}
      className={
        inline
          ? 'flex items-center gap-0.5 rounded-xl border border-hairline bg-surface-2/60 px-2 py-1.5'
          : 'chrome-blur fixed inset-x-0 bottom-[calc(68px+env(safe-area-inset-bottom))] z-40 flex items-center gap-0.5 border-t border-hairline px-2 py-1.5 lg:static lg:inset-auto lg:rounded-xl lg:border lg:bg-surface-2/60 lg:backdrop-filter-none'
      }
    >
      {button(
        'Title',
        <Heading size={18} strokeWidth={2} />,
        (active?.heading ?? false) && !active?.inTitle,
        () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        active?.inTitle ?? false,
      )}
      {button('Bold', <Bold size={18} strokeWidth={2.2} />, active?.bold ?? false, () =>
        editor.chain().focus().toggleBold().run(),
      )}
      {button('Italic', <Italic size={18} strokeWidth={2} />, active?.italic ?? false, () =>
        editor.chain().focus().toggleItalic().run(),
      )}
      {button('Checklist', <ListChecks size={18} strokeWidth={2} />, active?.taskList ?? false, () =>
        editor.chain().focus().toggleTaskList().run(),
      )}
      {button('Bullet list', <List size={18} strokeWidth={2} />, active?.bulletList ?? false, () =>
        editor.chain().focus().toggleBulletList().run(),
      )}
      {button('Mention a teammate', <AtSign size={18} strokeWidth={2} />, false, startMention)}
      {trailing && <div className="ml-auto flex items-center gap-0.5">{trailing}</div>}
    </div>
  )
}

/** Pixels the software keyboard currently covers at the bottom of the window. */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () =>
      setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)))
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])
  return inset
}
