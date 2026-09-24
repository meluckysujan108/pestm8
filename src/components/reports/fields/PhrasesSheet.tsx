import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import {
  MAX_SNIPPETS_PER_FIELD,
  MAX_SNIPPET_LENGTH,
  sameSnippet,
} from '#/lib/reportTemplates/snippets'
import type { Snippet } from '#/lib/reportTemplates/snippets'

/**
 * The sentences this business writes over and over, one tap away.
 *
 * A phrase is added to what is in the box, not substituted for it: a
 * technician usually wants the standard wording AND the one thing that was
 * different about today. Tapping one closes the sheet, because the answer is
 * the textarea behind it and the point is to get back to it.
 */
export function PhrasesSheet({
  open,
  onClose,
  label,
  phrases,
  current,
  onPick,
  onSave,
  onRemove,
}: {
  open: boolean
  onClose: () => void
  /** The question these belong to, which is what the sheet is named for. */
  label: string
  phrases: Array<Snippet>
  /** What is written in the box right now, which is what can be saved. */
  current: string
  onPick: (phrase: Snippet) => void
  onSave: (text: string) => Promise<unknown>
  onRemove: (phrase: Snippet) => Promise<unknown>
}) {
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Remove mode belongs to one visit to this sheet. Left on, the next tap —
  // meant to insert a phrase — deletes one instead.
  function close() {
    setRemoving(false)
    setError(null)
    onClose()
  }

  const removable = phrases.filter((phrase) => phrase.canRemove)

  const written = current.trim()
  const tooLong = written.length > MAX_SNIPPET_LENGTH
  const savable =
    written !== '' &&
    !tooLong &&
    !phrases.some((phrase) => sameSnippet(phrase.text, written)) &&
    phrases.length < MAX_SNIPPETS_PER_FIELD

  return (
    <Sheet
      open={open}
      onClose={close}
      title={label}
      description="Wording your business reuses. Tapping one adds it to what is written."
      footer={
        <div className="flex gap-2">
          {removable.length > 0 && (
            <button
              type="button"
              onClick={() => setRemoving((was) => !was)}
              className="h-11 rounded-xl bg-surface-2 px-4 text-[15px] font-semibold text-ink"
            >
              {removing ? 'Done removing' : 'Remove'}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="h-11 flex-1 rounded-xl bg-ink text-[15px] font-semibold text-surface"
          >
            Done
          </button>
        </div>
      }
    >
      {phrases.length === 0 ? (
        <p className="px-1 py-2 text-caption text-muted">
          No phrases yet. Write an answer, then save it here and it is one tap
          away on every report that asks this.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {phrases.map((phrase) => (
            <li key={phrase.id} className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={removing}
                onClick={() => {
                  onPick(phrase)
                  close()
                }}
                className="min-h-12 flex-1 rounded-xl border border-hairline bg-surface px-3 py-2.5 text-left text-body text-ink transition active:scale-[.995] disabled:opacity-60"
              >
                {phrase.text}
              </button>
              {removing && phrase.canRemove && (
                <button
                  type="button"
                  aria-label={`Remove phrase: ${phrase.text}`}
                  onClick={() => {
                    setError(null)
                    void onRemove(phrase).catch(() =>
                      setError('Could not remove that phrase.'),
                    )
                  }}
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted transition active:scale-[.95]"
                >
                  <Trash2 size={16} strokeWidth={1.9} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {savable && (
        <button
          type="button"
          onClick={() => {
            setError(null)
            void onSave(written).catch(() =>
              setError('Could not save that phrase.'),
            )
          }}
          className="mt-3 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink transition active:scale-[.98]"
        >
          <Plus size={16} strokeWidth={2} />
          Save what’s written
        </button>
      )}

      {tooLong && (
        <p className="mt-3 text-caption text-muted">
          Too long to keep as a phrase — {written.length} characters, and the
          limit is {MAX_SNIPPET_LENGTH}. It stays in the answer either way.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-caption text-amber-ink">
          {error}
        </p>
      )}

      {written !== '' &&
        !tooLong &&
        phrases.length >= MAX_SNIPPETS_PER_FIELD && (
          <p className="mt-3 text-caption text-muted">
            This question holds {MAX_SNIPPETS_PER_FIELD} phrases, which is as
            many as anyone reads. Remove one to save another.
          </p>
        )}
    </Sheet>
  )
}
