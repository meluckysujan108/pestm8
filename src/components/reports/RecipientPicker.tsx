import { useCallback, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CircleAlert, Info } from 'lucide-react'
import {
  emailDomain,
  emailProblem,
  emailTypoFix,
} from '../../../convex/lib/email'
import { FieldMessage } from '#/components/forms/FieldMessage'
import {
  describedBy,
  fieldInputClass,
  fieldMessageId,
} from '#/components/forms/FormField'
import { NEUTRAL_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { checkEmailDomain } from '#/lib/emailDomainCheck'
import { domainsWithoutMail, noMailMessage } from './fields/staticBlocks'
import { TickBox } from './TickBox'

/**
 * Choosing who a report is emailed to, the same way wherever it is chosen:
 * the Send sheet of a finished report, and the sheet that locks a draft.
 *
 * A row per person — who they are, their address whole, ticked or not — and
 * one box to add anyone else, with the same rules in both places (Phase 3 of
 * the signing and email plan): what is typed goes with the tap that sends it;
 * a comma or a semicolon finishes an address; an address that can never be
 * delivered to holds the tap, and a near miss or a domain that takes no mail
 * holds it once; a pasted list goes in whole only when every address in it
 * is ready.
 */

/** The longest a send or a lock waits to hear whether a typed address's
 * domain takes mail, as a form's Save does: a lookup is only ever a warning,
 * so past this the address goes as it is. */
export const SEND_CHECK_MS = 3000

/**
 * A pasted list of addresses, split where a person would: at a comma, a
 * semicolon, a space or a new line. "Bob Smith <bob@x.com>; Jane
 * <jane@y.com>", as a mail app copies them, gives the addresses in the
 * brackets. A name stops at an @ or a new line, so it never takes an address
 * before it with it; what it cannot tell apart (a name with a comma in it, an
 * address and a name with only a space between) leaves a piece that is not an
 * address, so the paste goes into the box as it is, to be put right.
 */
export function splitPasted(text: string): Array<string> {
  return text
    .replace(/[^,;<>@\n]*<([^<>]*)>/g, ',$1,')
    .split(/[\s,;]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean)
}

/** What a tap that sends (or locks) found in the box. */
export type PendingAddress =
  /** Nothing typed. */
  | { kind: 'none' }
  /** Held in the box, with the reason under it. */
  | { kind: 'held' }
  /** Ready, and taken: it goes with the tap. */
  | { kind: 'taken'; address: string }
  /** The tap was given up while the domain was being asked about (the
   * sheet closed and opened again): nothing was taken. */
  | { kind: 'abandoned' }

export type AddressDraft = ReturnType<typeof useAddressDraft>

/**
 * The box's state and its rules. `onTake` is told of each address it lets
 * through — the sheet chooses it, or lists it chosen.
 */
export function useAddressDraft({
  onTake,
  onAdded,
  onKeepOpen,
  isOpen = () => true,
}: {
  onTake: (address: string) => void
  /** After Add (or Return) took one: the Send sheet closes the box. */
  onAdded?: () => void
  /** After a comma or a pasted list took some: another is coming. */
  onKeepOpen?: () => void
  /** Whether the sheet is open: a hold puts focus in the box only then. */
  isOpen?: () => boolean
}) {
  const [draft, setDraft] = useState('')
  // What is wrong with the typed address shows once the field is left or Add
  // pressed, not while it is still going in. `typoAsked` is the address a
  // "Did you mean" was shown for: pressing Add again adds it as typed.
  const [shown, setShown] = useState(false)
  const [typoAsked, setTypoAsked] = useState<string | null>(null)
  // Domains DNS has said take no mail (src/lib/emailDomainCheck.ts), asked as
  // a typed address is left or added. A warning only: it may still be sent.
  const [noMail, setNoMail] = useState<ReadonlyArray<string>>([])
  // A tap that sends asking about a typed address's domain before it goes.
  const [checking, setChecking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()

  const typed = draft.trim().toLowerCase()
  const problem = typed === '' ? null : emailProblem(typed)
  // Offered with the error too: "bob@gmail" is refused, and bob@gmail.com is
  // almost certainly what was meant.
  const fix = typed === '' ? null : emailTypoFix(typed)
  const domain = problem === null ? emailDomain(typed) : null
  // Asked about: "Did you mean…?", or a domain that takes no mail.
  const asking = typoAsked !== null && typoAsked === typed

  /** Asks DNS about these addresses' domains, and remembers the ones that
   * take no mail. Only ever added to: the answer is about the domain. */
  function askDomains(addresses: ReadonlyArray<string>) {
    void domainsWithoutMail(addresses).then((found) => {
      if (found.length === 0) return
      setNoMail((prev) => [...new Set([...prev, ...found])])
    })
  }

  /** The domain of `address`, when DNS has said it takes no mail. */
  function noMailOf(address: string): string | null {
    const of = emailDomain(address)
    return of !== null && noMail.includes(of) ? of : null
  }

  function focus() {
    if (isOpen()) inputRef.current?.focus()
  }

  /**
   * Takes an address as someone to send to, or keeps it in the box with the
   * reason it needs another look. One that can never be delivered to stays
   * there with the reason under it. A near miss of a common provider asks,
   * and so does a domain DNS has said takes no mail; only a `confirm`ing take
   * (Add anyway, or the tap that sends) lets it through as typed, never a
   * comma typed after it.
   */
  function take(
    address: string,
    {
      confirm,
      noMailDomains = noMail,
    }: { confirm: boolean; noMailDomains?: ReadonlyArray<string> },
  ): 'added' | 'held' {
    if (emailProblem(address) !== null) {
      setDraft(address)
      setTypoAsked(null)
      setShown(true)
      focus()
      return 'held'
    }
    const of = emailDomain(address)
    const asks =
      emailTypoFix(address) !== null ||
      (of !== null && noMailDomains.includes(of))
    if (asks && !(confirm && typoAsked === address)) {
      setDraft(address)
      setTypoAsked(address)
      setShown(true)
      // To the box, whose warning it then reads out: a tap held with
      // nothing said was a tap that did nothing.
      focus()
      return 'held'
    }
    askDomains([address])
    onTake(address)
    return 'added'
  }

  // Stable, for a sheet that resets the box as it opens.
  const clear = useCallback(() => {
    setDraft('')
    setShown(false)
    setTypoAsked(null)
  }, [])

  /** Add, or Return in the box. */
  function addTyped() {
    if (typed === '') return
    if (take(typed, { confirm: true }) === 'held') return
    clear()
    onAdded?.()
  }

  /**
   * A comma or a semicolon just typed after an address finishes it, as Add
   * does, and never takes one that asked "Did you mean…?" as it is. Only at
   * the end, as it is typed: one typed into the middle of an address is left
   * for the box to say what is wrong with it.
   */
  function finishOnSeparator(value: string, inserted: string | null): boolean {
    const separator = value.at(-1)
    if (separator !== ',' && separator !== ';') return false
    // Typed (or a keyboard's word put in whole), not pasted.
    if (inserted === null || !inserted.endsWith(separator)) return false
    const address = value.slice(0, -1).trim().toLowerCase()
    if (/[\s,;]/.test(address)) return false
    // Nothing before it: the separator alone goes nowhere.
    if (address === '') return true
    if (take(address, { confirm: false }) === 'added') {
      clear()
      onKeepOpen?.()
    }
    return true
  }

  /**
   * A pasted list goes in whole when every address in it is ready to send;
   * otherwise it lands in the box like anything else, to be put right. One
   * address with a name around it goes into the box as just the address.
   */
  function pasteList(text: string): boolean {
    if (typed !== '') return false
    const addresses = splitPasted(text)
    if (addresses.length === 1) {
      if (addresses[0] === text.trim().toLowerCase()) return false
      setDraft(addresses[0])
      setShown(false)
      setTypoAsked(null)
      return true
    }
    if (addresses.length === 0) return false
    const ready = addresses.every((address) => {
      const of = emailDomain(address)
      return (
        emailProblem(address) === null &&
        emailTypoFix(address) === null &&
        !(of !== null && noMail.includes(of))
      )
    })
    if (!ready) return false
    for (const address of addresses) take(address, { confirm: false })
    clear()
    onKeepOpen?.()
    return true
  }

  /**
   * What is typed, for a tap that sends (or locks): it goes with the tap,
   * unless it needs another look. Asked before it goes rather than said
   * after: whether the domain takes mail at all, which a tap straight from
   * the box left no time to learn. Only the domain is sent; an answer already
   * had (the box was left) is no wait at all, and past `SEND_CHECK_MS` it
   * goes.
   */
  async function takePending({
    stillWanted,
  }: {
    /** Asked once the domain is known: false, and nothing is taken. */
    stillWanted?: () => boolean
  } = {}): Promise<PendingAddress> {
    const address = typed
    if (address === '') return { kind: 'none' }
    setChecking(true)
    const giveUp = new AbortController()
    const timer = setTimeout(() => giveUp.abort(), SEND_CHECK_MS)
    let fresh: ReadonlyArray<string> = []
    try {
      fresh = await domainsWithoutMail([address], (of) =>
        checkEmailDomain(of, { signal: giveUp.signal }),
      )
    } finally {
      clearTimeout(timer)
      setChecking(false)
    }
    if (fresh.length > 0) {
      setNoMail((prev) => [...new Set([...prev, ...fresh])])
    }
    if (stillWanted && !stillWanted()) return { kind: 'abandoned' }
    if (
      take(address, { confirm: true, noMailDomains: [...noMail, ...fresh] }) ===
      'held'
    ) {
      return { kind: 'held' }
    }
    clear()
    return { kind: 'taken', address }
  }

  /** "Use it" on a near miss, or "Use bob@gmail.com" on one that can't be
   * delivered: the fix goes into the box, to be looked at. */
  function applyFix(next: string) {
    setDraft(next)
    setShown(false)
    setTypoAsked(null)
    inputRef.current?.focus()
  }

  const reset = useCallback(() => {
    clear()
    setChecking(false)
  }, [clear])

  return {
    draft,
    setDraft,
    typed,
    problem,
    fix,
    domain,
    asking,
    shown,
    setShown,
    checking,
    inputRef,
    id,
    noMail,
    askDomains,
    noMailOf,
    take,
    clear,
    addTyped,
    finishOnSeparator,
    pasteList,
    takePending,
    applyFix,
    reset,
  }
}

/**
 * The box itself: the address, Add, and what is wrong with what is typed —
 * the reason it can't be delivered, "Did you mean…?", or a domain that takes
 * no mail — then, for an address that would go as it is, whether the client's
 * record has it.
 */
export function AddressBox({
  draft,
  autoFocus = false,
  newToClient = false,
  below,
}: {
  draft: AddressDraft
  autoFocus?: boolean
  /** Say "Not on the client’s record" under it: what its row would say. */
  newToClient?: boolean
  /** Anything else about the typed address, under the rest. */
  below?: ReactNode
}) {
  const { typed, problem, fix, domain, shown, checking } = draft
  const showProblem = shown && problem !== null
  const showTypo = shown && problem === null && fix !== null
  const showNoMail =
    fix === null && domain !== null && draft.noMail.includes(domain)
  const showInfo =
    newToClient && typed !== '' && problem === null && !showTypo && !showNoMail
  const errorId = fieldMessageId(draft.id, 'error')
  const warningId = fieldMessageId(draft.id, 'warning')
  const infoId = `${draft.id}-info`

  return (
    <div className="mt-2">
      <div className="flex gap-2">
        <input
          ref={draft.inputRef}
          id={draft.id}
          autoFocus={autoFocus}
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          // Held while a tap asks about it: what goes is what was there when
          // it was tapped.
          readOnly={checking}
          value={draft.draft}
          onPaste={(event) => {
            if (draft.pasteList(event.clipboardData.getData('text'))) {
              event.preventDefault()
            }
          }}
          onChange={(event) => {
            const inserted =
              'data' in event.nativeEvent
                ? (event.nativeEvent as InputEvent).data
                : null
            if (draft.finishOnSeparator(event.target.value, inserted)) return
            const next = event.target.value.trim().toLowerCase()
            // Put right (or cleared), it goes quiet until next left.
            if (
              next === '' ||
              (emailProblem(next) === null && emailTypoFix(next) === null)
            ) {
              draft.setShown(false)
            }
            draft.setDraft(event.target.value)
          }}
          onBlur={() => {
            draft.setShown(problem !== null || fix !== null)
            // Ask now, so Add has the answer waiting. Only the domain goes.
            if (problem === null && fix === null && typed !== '') {
              draft.askDomains([typed])
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              draft.addTyped()
            }
          }}
          aria-label="Email address"
          aria-invalid={showProblem || undefined}
          aria-describedby={describedBy(
            showProblem && errorId,
            (showTypo || showNoMail) && warningId,
            showInfo && infoId,
          )}
          placeholder="name@example.com"
          // The app's own field, not a well of its own that all but vanished
          // against the sheet.
          className={`${fieldInputClass('md', showProblem)} min-w-0 flex-1`}
        />
        <button
          type="button"
          onClick={draft.addTyped}
          disabled={checking}
          // Ink, not grey: a grey fill all but vanishes on a sheet.
          className={`${NEUTRAL_BUTTON_COMPACT} shrink-0 px-4`}
        >
          {draft.asking ? 'Add anyway' : 'Add'}
        </button>
      </div>
      {showProblem && (
        <FieldMessage
          id={errorId}
          tone="error"
          fix={
            fix
              ? { label: `Use ${fix}`, onApply: () => draft.applyFix(fix) }
              : undefined
          }
        >
          {problem}
        </FieldMessage>
      )}
      {showTypo && (
        <FieldMessage
          id={warningId}
          tone="warning"
          fix={{ label: 'Use it', onApply: () => draft.applyFix(fix) }}
        >
          Did you mean {fix}?
        </FieldMessage>
      )}
      {showNoMail && (
        <FieldMessage id={warningId} tone="warning">
          {noMailMessage(domain)}
        </FieldMessage>
      )}
      {/* What its row would say, said of the address still in the box: the
          tap that sends takes it as it is. */}
      {showInfo && (
        <p
          id={infoId}
          className="mt-1.5 flex items-center gap-1 px-1 text-caption text-ink-2"
        >
          <Info
            size={13}
            strokeWidth={2}
            aria-hidden
            className="shrink-0 text-blue"
          />
          Not on the client’s record
        </p>
      )}
      {below}
    </div>
  )
}

/**
 * One person a report could go to: ticked or not, who they are from the
 * client book ("Jane Nguyen · Client"), and the address whole — never cut
 * off, since the end of an address is where a typo in its domain would be.
 */
export function RecipientRow({
  address,
  chosen,
  who,
  newToClient = false,
  noMailDomain = null,
  noMailId,
  disabled = false,
  onToggle,
  children,
}: {
  address: string
  chosen: boolean
  who: { name: string; role: string } | null
  /** Say "Not on the client’s record" — before the tap that sends it, where
   * a typo would be. Said chosen or not, so the row's name does not change
   * as it is toggled. */
  newToClient?: boolean
  /** A domain DNS has said takes no mail: a warning under the row. */
  noMailDomain?: string | null
  noMailId: string
  disabled?: boolean
  onToggle: () => void
  /** More about it, under the address: when it was sent, and so on. */
  children?: ReactNode
}) {
  return (
    <>
      <button
        type="button"
        aria-pressed={chosen}
        aria-describedby={noMailDomain ? noMailId : undefined}
        disabled={disabled}
        onClick={onToggle}
        // Not chosen reads from the empty tick and the grey fill — never faded
        // text, which in sun reads as "can't be picked".
        className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-blue ${
          chosen ? 'border-ink/15 bg-surface' : 'border-hairline bg-surface-2'
        }`}
      >
        <TickBox on={chosen} />
        <span className="min-w-0 flex-1">
          {who && (
            <span className="block break-words text-body text-ink">
              <span className="font-semibold">{who.name}</span>
              {who.role && <span className="text-ink-2"> · {who.role}</span>}
            </span>
          )}
          <span
            className={`block break-words ${who ? 'text-caption text-ink-2' : 'text-body text-ink'}`}
          >
            {address}
          </span>
          {children}
          {newToClient && (
            <span className="mt-0.5 flex items-center gap-1 text-caption text-ink-2">
              <Info
                size={13}
                strokeWidth={2}
                aria-hidden
                className="shrink-0 text-blue"
              />
              Not on the client’s record
            </span>
          )}
        </span>
      </button>
      {noMailDomain && (
        <FieldMessage id={noMailId} tone="warning">
          {noMailMessage(noMailDomain)}
        </FieldMessage>
      )}
    </>
  )
}

/**
 * An address on file that can never be delivered to, shown as it is — not a
 * choice, since the server refuses it — with the address most likely meant
 * one tap away.
 */
export function UndeliverableChip({
  address,
  problem,
  fix,
  fixChosen,
  onFix,
}: {
  address: string
  problem: string
  fix: string | null
  /** The fix is already on the list and chosen, so it is not offered again. */
  fixChosen: boolean
  onFix: (fix: string) => void
}) {
  // Not a button: there is nothing to choose. The line under it is read
  // straight after, in order.
  return (
    <>
      <div className="flex w-full items-center gap-2.5 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5">
        <span aria-hidden className="size-5 shrink-0 rounded-md bg-surface-3" />
        <span className="min-w-0 flex-1 truncate text-body text-ink">
          {address}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-caption text-red-ink">
          <CircleAlert size={13} strokeWidth={2} />
          Can’t be delivered
        </span>
      </div>
      <FieldMessage
        tone="warning"
        fix={
          fix && !fixChosen
            ? { label: `Use ${fix}`, onApply: () => onFix(fix) }
            : undefined
        }
      >
        {problem}
      </FieldMessage>
    </>
  )
}
