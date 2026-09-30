import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { useTiptapSync } from '@convex-dev/prosemirror-sync/tiptap'
import { EditorContent, useEditor } from '@tiptap/react'
import { useConvex } from 'convex/react'
import { ConvexError } from 'convex/values'
import { api } from '../../../convex/_generated/api'
import { FormatBar } from './FormatBar'
import { mentionSuggestion } from './mentionSuggestion'
import { noteExtensions } from './noteExtensions'
import type { Id } from '../../../convex/_generated/dataModel'
import type { AnyExtension, Content } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import type { ConvexReactClient } from 'convex/react'
import type { ReactNode } from 'react'
import type { MentionItem } from './MentionList'
import { TextPending } from '#/components/shell/Pending'
import { FormAlert } from '#/components/forms/FormAlert'

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
  mentions = true,
  autoFocus = false,
  onAutoFocused,
  trailingTools,
  inline = false,
  onEmptyChange,
  onClosed,
}: {
  businessId: Id<'businesses'>
  noteId: Id<'notes'>
  members: Array<MentionItem>
  editable: boolean
  /** Whether @ tags a teammate. Off in a personal note. */
  mentions?: boolean
  /** Put the cursor in the title: a page just made with + is for typing on. */
  autoFocus?: boolean
  /** Told once the editor has taken focus, so it is done only the once. */
  onAutoFocused?: () => void
  trailingTools?: ReactNode
  /** Embedded in a sheet: toolbar in the flow, no floating bar, no own scroll. */
  inline?: boolean
  /** Told whether the note has anything in it, as it opens and as it is typed
   * in — so a note made and left empty can be cleared away. */
  onEmptyChange?: (empty: boolean) => void
  /** Told as it closes, with its save on closing: settled once that save
   * has landed, or once there was nothing to save. */
  onClosed?: (saved: Promise<void>) => void
}) {
  // Sync errors would otherwise vanish as unhandled rejections. A revoked
  // note (deleted under you, or access withdrawn) stops taking keystrokes
  // straight away instead of when the metadata query catches up.
  const [syncError, setSyncError] = useState<unknown>(null)
  const sync = useTiptapSync(api.notesSync, noteId, {
    snapshotDebounceMs: 800,
    onSyncError: (error) => {
      // An older copy of the note refused because a newer one has landed
      // (`notesSync` onSnapshot): nothing is lost, so nothing to say.
      if (error instanceof ConvexError && error.data === 'SNAPSHOT_SUPERSEDED') return
      setSyncError(error)
    },
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
    return <TextPending />
  }
  if (sync.initialContent === null) {
    return <div className="px-4 py-6 text-body text-muted">This note is no longer available.</div>
  }

  return (
    <>
      {syncError !== null && (
        <FormAlert className="mx-4 mt-2 lg:mx-2">
          {revoked
            ? 'This note can no longer be edited from here.'
            : 'Your last change could not be synced. Copy your text before leaving this note.'}
        </FormAlert>
      )}
      <SyncedEditor
        key={noteId}
        noteId={noteId}
        initialContent={sync.initialContent}
        syncExtension={sync.extension}
        members={members}
        editable={editable && !revoked}
        mentions={mentions}
        autoFocus={autoFocus}
        onAutoFocused={onAutoFocused}
        trailingTools={trailingTools}
        inline={inline}
        onEmptyChange={onEmptyChange}
        onClosed={onClosed}
      />
    </>
  )
}

function SyncedEditor({
  noteId,
  initialContent,
  syncExtension,
  members,
  editable,
  mentions,
  autoFocus,
  onAutoFocused,
  trailingTools,
  inline,
  onEmptyChange,
  onClosed,
}: {
  noteId: Id<'notes'>
  initialContent: Content
  syncExtension: AnyExtension
  members: Array<MentionItem>
  editable: boolean
  mentions: boolean
  autoFocus: boolean
  onAutoFocused?: () => void
  trailingTools?: ReactNode
  inline: boolean
  onEmptyChange?: (empty: boolean) => void
  onClosed?: (saved: Promise<void>) => void
}) {
  const onEmptyChangeRef = useRef(onEmptyChange)
  onEmptyChangeRef.current = onEmptyChange
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed
  // Read through refs so the suggestion sees roster and personal/shared
  // changes without rebuilding the editor (which would drop its collab state).
  const membersRef = useRef(members)
  membersRef.current = members
  const mentionsRef = useRef(mentions)
  mentionsRef.current = mentions
  // Read once, at mount: the parent clears it as soon as focus is taken, and
  // a changed option would make the editor drop the focus it just took.
  const [focusOnMount] = useState(autoFocus)

  const extensions = useMemo(
    () => [
      ...noteExtensions(
        mentionSuggestion(
          () => membersRef.current,
          () => mentionsRef.current,
        ),
      ),
      syncExtension,
    ],
    [syncExtension],
  )

  const editor = useEditor({
    extensions,
    content: initialContent,
    editable,
    // The first block is the title.
    autofocus: focusOnMount && editable ? 'start' : false,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'note-editor', 'aria-label': 'Note body' },
    },
  })

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  // Saved as it closes. The sync saves a copy of the whole note a moment
  // after typing stops, and drops that save if the editor closes first: the
  // words are kept, as edits, but the note's title and preview come from the
  // saved copy — so a note closed straight after typing was "New note" in
  // every list, and missing from search, until someone edited it again.
  //
  // Only by an editor that was typed in: like the sync's own save, one that
  // has only watched a teammate's words arrive leaves the save to them —
  // a save is credited to whoever makes it ("Edited by").
  const convex = useConvex()
  const editableRef = useRef(editable)
  editableRef.current = editable
  useEffect(() => {
    if (!editor) return
    const opened = collabState(editor.state)?.version
    // A change typed here waits on the server's word; one received never does.
    let typedHere = false
    const onTransaction = () => {
      if ((collabState(editor.state)?.unconfirmed ?? 0) > 0) typedHere = true
    }
    editor.on('transaction', onTransaction)
    return () => {
      editor.off('transaction', onTransaction)
      const at = collabState(editor.state)
      const saved =
        typedHere &&
        editableRef.current &&
        opened !== undefined &&
        at &&
        at.version + at.unconfirmed > opened
          ? saveOnClose(
              convex,
              noteId,
              at,
              JSON.stringify(editor.state.doc.toJSON()),
              // Never an error: at worst the next edit saves it, as before.
            ).catch(() => {})
          : Promise.resolve()
      onClosedRef.current?.(saved)
    }
  }, [editor, convex, noteId])

  useEffect(() => {
    if (editor && focusOnMount) onAutoFocused?.()
  }, [editor, focusOnMount, onAutoFocused])

  // Empty is no words and nothing else — no photo, no @mention, no ticked
  // box: what the person sees, before the server's snapshot has caught up.
  useEffect(() => {
    if (!editor) return
    const report = () => {
      let empty = editor.state.doc.textContent.trim() === ''
      if (empty) {
        editor.state.doc.descendants((node) => {
          // Text is a leaf too, and blank text was ruled on above.
          if (node.isAtom && !node.isText && node.type.name !== 'hardBreak') {
            empty = false
          }
          if (node.type.name === 'taskItem' && node.attrs.checked) empty = false
          return empty
        })
      }
      onEmptyChangeRef.current?.(empty)
    }
    report()
    editor.on('update', report)
    return () => {
      editor.off('update', report)
    }
  }, [editor])

  if (inline) {
    return (
      <div className="flex flex-col gap-2">
        <EditorContent editor={editor} className="px-1 py-1" />
        {editable && (
          <FormatBar
            editor={editor}
            mentions={mentions}
            trailing={trailingTools}
            inline
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editable && (
        <div className="order-2 lg:order-1 lg:mb-2">
          <FormatBar editor={editor} mentions={mentions} trailing={trailingTools} />
        </div>
      )}
      <div className="order-1 min-h-0 flex-1 overflow-y-auto pb-24 lg:order-2 lg:pb-8">
        <EditorContent editor={editor} className="px-4 py-3 lg:px-2" />
      </div>
    </div>
  )
}

type CollabPoint = {
  /** The server version this editor has caught up to. */
  version: number
  /** Its own edits not yet confirmed by the server. */
  unconfirmed: number
  clientId: number
}

/**
 * Where this editor stands with the server. Read from the collaboration
 * plugin's own state, found by its key — the plugin belongs to the sync
 * library, which brings its own copy — and undefined if it is not there, so
 * a change in the library costs the save on close and nothing else.
 */
function collabState(state: EditorState): CollabPoint | undefined {
  const plugin = state.plugins.find(
    (p) =>
      (p.spec.key as unknown as { key?: string } | undefined)?.key ===
      'collab$',
  )
  const value = plugin?.getState(state) as
    | { version?: unknown; unconfirmed?: unknown }
    | undefined
  const clientId = (plugin?.spec.config as { clientID?: unknown } | undefined)
    ?.clientID
  if (
    typeof value?.version !== 'number' ||
    !Array.isArray(value.unconfirmed) ||
    typeof clientId !== 'number'
  ) {
    return undefined
  }
  return {
    version: value.version,
    unconfirmed: value.unconfirmed.length,
    clientId,
  }
}

/** How long a closed note waits for its last edits before giving up. */
const LAND_WITHIN_MS = 30_000

/**
 * Saves a closed editor's note as it stood when it closed. With its own
 * edits all confirmed, straight away. With some still on their way — the
 * sync sends them after it closes — once they have landed, and only if they
 * landed together, straight after the version it had: had anyone else's
 * edit come between, the note on the server is not the one it closed on,
 * and saving this copy would lose theirs.
 */
async function saveOnClose(
  convex: ConvexReactClient,
  noteId: Id<'notes'>,
  at: CollabPoint,
  content: string,
): Promise<void> {
  const version = at.version + at.unconfirmed
  if (at.unconfirmed > 0) {
    const landed = await new Promise<boolean>((resolve) => {
      const watch = convex.watchQuery(api.notesSync.latestVersion, {
        id: noteId,
      })
      // Called only once both below exist: by the check after them, a
      // later update, or the timer.
      const done = (ok: boolean) => {
        clearTimeout(timer)
        unsubscribe()
        resolve(ok)
      }
      const check = () => {
        try {
          const latest = watch.localQueryResult()
          if (typeof latest === 'number' && latest >= version) done(true)
        } catch {
          done(false)
        }
      }
      const unsubscribe = watch.onUpdate(check)
      const timer = setTimeout(() => done(false), LAND_WITHIN_MS)
      check()
    })
    if (!landed) return
    const after = await convex.query(api.notesSync.getSteps, {
      id: noteId,
      version: at.version,
    })
    const ours = after.clientIds.slice(0, at.unconfirmed)
    if (
      ours.length < at.unconfirmed ||
      ours.some((clientId) => clientId !== at.clientId)
    ) {
      return
    }
  }
  await convex.mutation(api.notesSync.submitSnapshot, {
    id: noteId,
    version,
    content,
  })
}
