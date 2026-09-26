import { useId, useState } from 'react'
import { Check, Copy, Share } from 'lucide-react'
import {
  PRIMARY_BUTTON,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'

/**
 * Ten single-use recovery codes, shown once, and a person made to put them
 * somewhere before moving on.
 *
 * Shown only here, straight after they are made: the server stores them
 * encrypted and there is no "show my codes again". Hence the checkbox —
 * Continue stays off until they say the codes are saved, and saved
 * somewhere other than this phone, because the phone going missing is the
 * whole reason the codes exist. A technician who loses their phone on a job
 * signs back in on a borrowed one with a code from their wallet; one who
 * saved the codes in the phone's own notes is locked out until the owner can
 * reset them.
 *
 * Share uses the phone's own share sheet (text only — Notes, Messages to
 * yourself, AirDrop to a laptop, a printer); nothing is downloaded and
 * nothing leaves the app except by the person's own choice of where.
 */
export function RecoveryCodes({
  codes,
  onDone,
  doneLabel = 'Continue',
}: {
  codes: ReadonlyArray<string>
  onDone: () => void
  doneLabel?: string
}) {
  const checkId = useId()
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const text = [
    'PestM8 recovery codes. Each works once, in place of the code from your authenticator app.',
    '',
    ...codes,
  ].join('\n')
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-muted">
        If your phone is lost, stolen or broken, one of these gets you back in —
        on any phone, in place of the code from your authenticator app. Each one
        works once. Keep them somewhere{' '}
        <span className="text-ink">other than this phone</span>: your wallet,
        the ute's glovebox, or with the office.
      </p>

      <ol className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl border border-hairline bg-surface p-4 font-mono text-[16px] text-ink">
        {codes.map((code) => (
          <li key={code} className="select-all tracking-wide">
            {code}
          </li>
        ))}
      </ol>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            setNote(null)
            navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              },
              () => setNote('Could not copy. Write them down instead.'),
            )
          }}
          className={`${SECONDARY_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2`}
        >
          {copied ? (
            <Check size={16} strokeWidth={2} />
          ) : (
            <Copy size={16} strokeWidth={1.7} />
          )}
          {copied ? 'Copied' : 'Copy all'}
        </button>
        {canShare && (
          <button
            type="button"
            onClick={() => {
              setNote(null)
              navigator
                .share({ title: 'PestM8 recovery codes', text })
                .catch((error: unknown) => {
                  // Closing the share sheet is not a failure.
                  if ((error as { name?: string }).name !== 'AbortError') {
                    setNote('Could not share. Copy them or write them down.')
                  }
                })
            }}
            className={`${SECONDARY_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2`}
          >
            <Share size={16} strokeWidth={1.7} />
            Share
          </button>
        )}
      </div>

      {note && <p className="text-caption text-amber-ink">{note}</p>}

      <label
        htmlFor={checkId}
        className="flex items-start gap-3 rounded-2xl border border-hairline bg-surface p-4"
      >
        <input
          id={checkId}
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-0.5 size-5 shrink-0 accent-red"
        />
        <span className="text-body text-ink">
          I've saved these somewhere other than this phone
        </span>
      </label>

      <button
        type="button"
        disabled={!saved}
        onClick={onDone}
        className={PRIMARY_BUTTON}
      >
        {doneLabel}
      </button>
    </div>
  )
}
