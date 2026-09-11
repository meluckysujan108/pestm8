import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { useTiptapSync } from '@convex-dev/prosemirror-sync/tiptap'
import { EditorContent, useEditor } from '@tiptap/react'
import { ConvexError } from 'convex/values'
import { api } from '../../../convex/_generated/api'
import { FormatBar } from './FormatBar'
import { mentionSuggestion } from './mentionSuggestion'
import { noteExtensions } from './noteExtensions'
import type { Id } from '../../../convex/_generated/dataModel'
import type { AnyExtension, Content } from '@tiptap/core'
import type { ReactNode } from 'react'
import type { MentionItem } from './MentionList'

/**
 * The note body, live-synced through the prosemirror-sync component. There
 * is no save button and no edit mode: every keystroke becomes a step the
 * server merges, and a debounced snapshot refreshes the list metadata.
 */
export function NoteEditor({
  businessId,
  noteId,
  members,
  editable,
  trailingTools,
  inline = false,
}: {
  businessId: Id<'businesses'>
  noteId: Id<'notes'>
  members: Array<MentionItem>
  editable: boolean
  trailingTools?: ReactNode
  /** Embedded in a sheet: toolbar in the flow, no floating bar, no own scroll. */
  inline?: boolean
}) {
  // Sync errors would otherwise vanish as unhandled rejections. A revoked
  // note (deleted under you, or access withdrawn) stops taking keystrokes
  // straight away instead of when the metadata query catches up.
  const [syncError, setSyncError] = useState<unknown>(null)
  const sync = useTiptapSync(api.notesSync, noteId, {
    snapshotDebounceMs: 800,
    onSyncError: setSyncError,
  })
  const revoked = syncError instanceof ConvexError && syncError.data === 'NO_ACCESS'

  const convexMarkRead = useConvexMutation(api.notes.markMentionsRead)
  const markRead = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'>; noteId: Id<'notes'> }) =>
      convexMarkRead(args),
  })
  const markReadMutate = markRead.mutate
  useEffect(() => {
    markReadMutate({ businessId, noteId })
  }, [businessId, noteId, markReadMutate])

  if (sync.isLoading) {
    return <div className="px-4 py-6 text-body text-muted">Loading…</div>
  }
  if (sync.initialContent === null) {
    return <div className="px-4 py-6 text-body text-muted">This note is no longer available.</div>
  }

  return (
    <>
      {syncError !== null && (
        <p
          role="alert"
          className="mx-4 mt-2 rounded-xl border border-amber-line bg-amber-bg px-3 py-2 text-caption text-amber-ink lg:mx-2"
        >
          {revoked
            ? 'This note can no longer be edited from here.'
            : 'Your last change could not be synced. Copy your text before leaving this note.'}
        </p>
      )}
      <SyncedEditor
        key={noteId}
        initialContent={sync.initialContent}
        syncExtension={sync.extension}
        members={members}
        editable={editable && !revoked}
        trailingTools={trailingTools}
        inline={inline}
      />
    </>
  )
}

function SyncedEditor({
  initialContent,
  syncExtension,
  members,
  editable,
  trailingTools,
  inline,
}: {
  initialContent: Content
  syncExtension: AnyExtension
  members: Array<MentionItem>
  editable: boolean
  trailingTools?: ReactNode
  inline: boolean
}) {
  // Read through a ref so the suggestion's `items()` sees roster changes
  // without rebuilding the editor (which would drop its collab state).
  const membersRef = useRef(members)
  membersRef.current = members

  const extensions = useMemo(
    () => [...noteExtensions(mentionSuggestion(() => membersRef.current)), syncExtension],
    [syncExtension],
  )

  const editor = useEditor({
    extensions,
    content: initialContent,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'note-editor', 'aria-label': 'Note body' },
    },
  })

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  if (inline) {
    return (
      <div className="flex flex-col gap-2">
        <EditorContent editor={editor} className="px-1 py-1" />
        {editable && <FormatBar editor={editor} trailing={trailingTools} inline />}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editable && (
        <div className="order-2 lg:order-1 lg:mb-2">
          <FormatBar editor={editor} trailing={trailingTools} />
        </div>
      )}
      <div className="order-1 min-h-0 flex-1 overflow-y-auto pb-24 lg:order-2 lg:pb-8">
        <EditorContent editor={editor} className="px-4 py-3 lg:px-2" />
      </div>
    </div>
  )
}
