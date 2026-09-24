import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { AddressLookupInput } from '#/components/clients/AddressLookupInput'
import { isOffline, networkLookupsAllowed } from '#/lib/addressLookup'
import {
  addressErrors,
  addressSignature,
  checkAddressOffline,
  loadLocalities,
  streetCheckUrl,
} from '#/lib/addressVerify'
import { AU_STATES } from '#/lib/au'
import { FieldMessage } from './FieldMessage'
import { describedBy, fieldInputClass, fieldMessageId } from './FormField'
import { useLatest, useSaveCheck } from './SaveWarnings'
import {
  addressBlank,
  addressChanged,
  addressCheckFor,
  checkStreetAtSave,
  issuesWithoutState,
  postcodeProblem,
} from './verifiedAddress'
import type { ReactNode } from 'react'
import type {
  AddressField,
  AddressIssue,
  AddressValue,
} from '#/lib/addressVerify'
import type { FieldSize } from './FormField'
import type { SaveWarning } from './saveWarningRules'
import type { AddressCheck, StreetCheckOutcome } from './verifiedAddress'

export {
  addressChanged,
  addressCheckFor,
  addressCheckToSend,
} from './verifiedAddress'
export type { AddressCheck } from './verifiedAddress'

/** A pause in typing before the suburb, state and postcode are checked
 * against each other. The tables are in memory by then; this is only so the
 * lines under the fields do not change at every key. */
const INLINE_CHECK_DELAY_MS = 400

const FIELD_NAMES: Record<AddressField, string> = {
  addressLine: 'Street address',
  suburb: 'Suburb',
  state: 'State',
  postcode: 'Postcode',
}

const ALL_FIELDS: ReadonlyArray<AddressField> = [
  'addressLine',
  'suburb',
  'state',
  'postcode',
]

/** What the line under the block says about the street. */
type StreetStatus = 'checking' | 'found' | 'no-signal'

/**
 * The address block every form uses: Street address (with suggestions),
 * Suburb, State and Postcode, checked as they go in and again at Save
 * (field verification).
 *
 * - A postcode that is not four digits is the one thing refused, and only
 *   when it was typed now: one already saved that way and left alone saves,
 *   with a warning. `initial` is what the record has saved.
 * - The suburb, state and postcode are checked against each other from the
 *   suburb tables, with no network, once the person has left the field —
 *   never while typing. A finished four-digit postcode is checked after a
 *   pause without leaving it: it is usually the last thing typed, and Save
 *   is the next thing pressed.
 * - At Save (inside a SaveWarningsProvider) those checks run again on the
 *   four fields as they are then, whatever was picked: a browser's or password
 *   manager's autofill can rewrite the suburb and postcode after a pick. When
 *   the fields no longer hold the picked suggestion, it counts as typed by
 *   hand and the street is looked for on the map too, for up to 3 seconds;
 *   no answer says nothing. An address left as saved is not looked up, and
 *   an optional one left blank is not checked at all.
 *
 * Everything but the postcode's four digits is a warning, listed above Save,
 * and the second press saves: the person at the door is looking at the
 * letterbox, and a new estate can be missing from the map for a year.
 *
 * The line under the block says "Street found" when a picked suggestion is
 * still what the fields hold, or the map found the street at Save — never
 * "address verified": the map knows streets, not houses.
 *
 * `onCheckChange` hears 'picked' or 'typed' whenever that changes (and once
 * on mount), for the property mutations' `addressCheck`; send it through
 * `addressCheckToSend`, which leaves it out for an address left as saved.
 *
 * All four inputs turn autofill away (autoComplete="off", and the attributes
 * 1Password and LastPass honour), since a fill after a pick is what makes the
 * re-check at Save necessary; the ones that ignore that are caught by it.
 *
 * Renders a fragment. With visible labels each field is spaced like
 * NewClientFields' (mt-4); with placeholders the fields have no margins, for
 * a parent that spaces its children with a gap (ClientSheet's cards). With
 * `showState` off the state is the business's own (`workState`), no State
 * field is shown, and a pick is stored with that state.
 */
export function VerifiedAddressFields({
  value,
  onChange,
  workState,
  initial,
  size = 'lg',
  labels = 'visible',
  required = true,
  showState = true,
  idPrefix,
  onCheckChange,
}: {
  value: AddressValue
  onChange: (patch: Partial<AddressValue>) => void
  /** The business's own state: suggestions there come first, and an address
   * in another is pointed out. */
  workState: string
  /** The saved address. Unchanged, it never blocks a save. */
  initial?: AddressValue
  size?: FieldSize
  labels?: 'visible' | 'placeholders'
  required?: boolean
  showState?: boolean
  /** The four inputs' ids are `${idPrefix}-street`, `-suburb`, `-state` and
   * `-postcode`; also the block's save checks' names. */
  idPrefix: string
  onCheckChange?: (addressCheck: AddressCheck) => void
}) {
  const ids: Record<AddressField, string> = {
    addressLine: `${idPrefix}-street`,
    suburb: `${idPrefix}-suburb`,
    state: `${idPrefix}-state`,
    postcode: `${idPrefix}-postcode`,
  }
  const statusId = `${idPrefix}-address-status`

  // What the checks see: with no State field, the state is the business's.
  const now: AddressValue = showState ? value : { ...value, state: workState }
  const saved =
    initial && (showState ? initial : { ...initial, state: workState })

  const [pickedSignature, setPickedSignature] = useState<string | null>(null)
  /** The last offline check's issues, and the suburb|state|postcode they are
   * for. */
  const [inline, setInline] = useState<{
    key: string
    issues: Array<AddressIssue>
  } | null>(null)
  /** After a pick, a fix or a new state, the last issues are about fields that
   * have all just changed: only issues for exactly what is there are shown,
   * until the next check. While typing, the other fields' issues stay up. */
  const [exactOnly, setExactOnly] = useState(false)
  /** The fields whose issues are on show: left, or finished. */
  const [shown, setShown] = useState<ReadonlySet<AddressField>>(new Set())
  const [postcodeErrorShown, setPostcodeErrorShown] = useState(false)
  /** The street check at Save, by the address signature it was for. */
  const [street, setStreet] = useState<{
    signature: string
    status: StreetStatus
  } | null>(null)
  /** The last street check's answer, by the exact fields it was for (its fix
   * carries the house number). Asked once per address, so the second press
   * of Save answers at once. */
  const streetAnswer = useRef<{
    key: string
    outcome: StreetCheckOutcome
  } | null>(null)
  /** Fields to put on show when the next offline check lands. */
  const showOnCheck = useRef(new Set<AddressField>())
  const postcodeRef = useRef<HTMLInputElement>(null)

  const signature = addressSignature(now)
  const check = addressCheckFor(now, pickedSignature)
  const blank = addressBlank(now)
  const changed = addressChanged(now, saved)
  const problem = postcodeProblem(now, saved)
  const blocking = problem?.blocks ? problem.issue : null
  const blockingMessage = blocking?.message ?? ''
  const offlineKey = offlineKeyOf(now)
  const exactKey = `${now.addressLine.trim()}\n${offlineKey}`

  const latest = useLatest(now)
  const latestOnChange = useLatest(onChange)
  const latestOnCheck = useLatest(onCheckChange)

  // Fetched while there is signal, so it is in hand at a door with none.
  useEffect(() => {
    void loadLocalities(workState)
  }, [workState])

  useEffect(() => {
    latestOnCheck.current?.(check)
  }, [check, latestOnCheck])

  useEffect(() => {
    postcodeRef.current?.setCustomValidity(blockingMessage)
  }, [blockingMessage])

  useEffect(() => {
    if (blank) {
      setInline(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      const target = latest.current
      void checkAddressOffline(target, { workState })
        .catch((): Array<AddressIssue> => [])
        .then((issues) => {
          if (!live) return
          setInline({ key: offlineKeyOf(target), issues })
          setExactOnly(false)
          const add = [...showOnCheck.current]
          showOnCheck.current.clear()
          if (add.length > 0) setShown((s) => new Set([...s, ...add]))
        })
    }, INLINE_CHECK_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [offlineKey, blank, workState, latest])

  function show(fields: ReadonlyArray<AddressField>) {
    setShown((s) =>
      fields.every((f) => s.has(f)) ? s : new Set([...s, ...fields]),
    )
  }

  function hide(field: AddressField) {
    setShown((s) => {
      if (!s.has(field)) return s
      const next = new Set(s)
      next.delete(field)
      return next
    })
  }

  /** A one-tap fix, from under a field or from the list above Save. Reads the
   * latest `onChange`: the list's fix runs long after the check that made it. */
  function applyFix(patch: Partial<AddressValue>) {
    setExactOnly(true)
    show(Object.keys(patch) as Array<AddressField>)
    if ('postcode' in patch) setPostcodeErrorShown(false)
    latestOnChange.current(patch)
  }

  function pick(address: AddressValue) {
    const next = showState ? address : { ...address, state: workState }
    setPickedSignature(addressSignature(next))
    setExactOnly(true)
    // A picked address is a finished one: its issues show once checked.
    show(ALL_FIELDS)
    setPostcodeErrorShown(false)
    onChange(next)
  }

  function focusField(field: AddressField) {
    document.getElementById(ids[field])?.focus()
  }

  function toWarning(issue: AddressIssue, id: string): SaveWarning {
    const fix = issue.fix
    return {
      id,
      label: FIELD_NAMES[issue.field],
      message: issue.message,
      ...(fix
        ? { fix: { label: fix.label, apply: () => applyFix(fix.patch) } }
        : {}),
      focus: () => focusField(issue.field),
    }
  }

  const visible = (issues: ReadonlyArray<AddressIssue>) =>
    showState ? [...issues] : issuesWithoutState(issues)

  // The suburb, state and postcode against each other, re-run on the fields as
  // they are at Save. Not for an address left as saved: an old record's
  // "usually 6050" would ask again at every save of anything else on it.
  useSaveCheck(
    `${idPrefix}-address`,
    () => {
      if (blank) return []
      const kept =
        problem && !problem.blocks
          ? [toWarning(problem.issue, `${ids.postcode}:saved`)]
          : []
      if (!changed) return kept
      return checkAddressOffline(now, { workState })
        .catch((): Array<AddressIssue> => [])
        .then((issues) => {
          const seen: Partial<Record<AddressField, number>> = {}
          return [
            ...kept,
            ...visible(issues).map((issue) => {
              const n = (seen[issue.field] ?? 0) + 1
              seen[issue.field] = n
              return toWarning(issue, `${ids[issue.field]}:${n}`)
            }),
          ]
        })
    },
    [now.suburb, now.state, now.postcode, changed],
  )

  // The street on the map, only when the address is not the suggestion
  // picked for it: typed by hand, or picked and rewritten by autofill since.
  useSaveCheck(
    `${idPrefix}-street-check`,
    (signal) => {
      if (blank || !changed || check === 'picked') return []
      if (!networkLookupsAllowed() || streetCheckUrl(now) === null) return []
      const said = (outcome: StreetCheckOutcome) =>
        outcome.status === 'not-found'
          ? [toWarning(outcome.issue, `${ids.addressLine}:street`)]
          : []
      const known = streetAnswer.current
      if (known?.key === exactKey) return said(known.outcome)
      if (isOffline()) {
        setStreet({ signature, status: 'no-signal' })
        return []
      }
      setStreet({ signature, status: 'checking' })
      const key = exactKey
      return checkStreetAtSave(now, { signal, workState }).then((outcome) => {
        if (outcome.status !== 'no-signal') {
          streetAnswer.current = { key, outcome }
        }
        setStreet(
          outcome.status === 'found' || outcome.status === 'no-signal'
            ? { signature, status: outcome.status }
            : null,
        )
        return said(outcome)
      })
    },
    [now.addressLine, now.suburb, now.state, now.postcode, check, changed],
  )

  // What is on show under the fields.
  const current =
    inline && (!exactOnly || inline.key === offlineKey)
      ? visible(inline.issues)
      : []
  const issuesFor = (field: AddressField) =>
    shown.has(field) ? current.filter((i) => i.field === field) : []
  const suburbIssues = issuesFor('suburb')
  const stateIssues = showState ? issuesFor('state') : []
  const postcodeIssues = issuesFor('postcode')
  const keptPostcode =
    problem && !problem.blocks && shown.has('postcode') ? problem.issue : null
  const showPostcodeError = blocking !== null && postcodeErrorShown

  const streetStatus: StreetStatus | null =
    check === 'picked'
      ? 'found'
      : street?.signature === signature
        ? street.status
        : null

  const labelled = labels === 'visible'
  const spacing = labelled ? 'mt-4 flex flex-col gap-1.5' : ''
  const inputClass = fieldInputClass(size)
  const turnAutofillAway = {
    autoComplete: 'off',
    'data-1p-ignore': true,
    'data-lpignore': 'true',
  } as const

  const label = (field: AddressField) =>
    labelled ? (
      <label htmlFor={ids[field]} className="section-label">
        {FIELD_NAMES[field]}
      </label>
    ) : null
  const unlabelled = (field: AddressField) =>
    labelled
      ? {}
      : { placeholder: FIELD_NAMES[field], 'aria-label': FIELD_NAMES[field] }

  const suburbWarningId = fieldMessageId(ids.suburb, 'warning')
  const stateWarningId = fieldMessageId(ids.state, 'warning')
  const postcodeErrorId = fieldMessageId(ids.postcode, 'error')
  const postcodeWarningId = fieldMessageId(ids.postcode, 'warning')

  return (
    <>
      <div className={spacing}>
        {label('addressLine')}
        <AddressLookupInput
          id={ids.addressLine}
          value={value.addressLine}
          onChange={(addressLine) => onChange({ addressLine })}
          // All four, postcode included even when the suggestion has none: a
          // postcode kept from the last address would belong somewhere else,
          // and a blank one is caught by `required`.
          onPick={pick}
          required={required}
          placeholder={labelled ? undefined : FIELD_NAMES.addressLine}
          ariaLabel={labelled ? undefined : FIELD_NAMES.addressLine}
          size={size}
          biasState={workState}
        />
      </div>

      <div className={spacing}>
        {label('suburb')}
        <div>
          <input
            id={ids.suburb}
            type="text"
            value={value.suburb}
            required={required}
            {...unlabelled('suburb')}
            {...turnAutofillAway}
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              hide('suburb')
              onChange({ suburb: e.target.value })
            }}
            onBlur={() => show(['suburb'])}
            aria-describedby={describedBy(
              suburbIssues.length > 0 && suburbWarningId,
            )}
            className={inputClass}
          />
          <Warnings id={suburbWarningId} issues={suburbIssues} fix={applyFix} />
        </div>
      </div>

      <div className={labelled ? 'mt-4' : ''}>
        <div className={`grid grid-cols-2 ${labelled ? 'gap-3' : 'gap-2.5'}`}>
          {showState && (
            <div className="flex flex-col gap-1.5">
              {label('state')}
              <select
                id={ids.state}
                value={value.state}
                {...(labelled ? {} : { 'aria-label': FIELD_NAMES.state })}
                {...turnAutofillAway}
                onChange={(e) => {
                  // A choice, not typing: finished as soon as it is made.
                  setExactOnly(true)
                  show(['state'])
                  onChange({ state: e.target.value })
                }}
                onBlur={() => show(['state'])}
                aria-describedby={describedBy(
                  stateIssues.length > 0 && stateWarningId,
                )}
                className={inputClass}
              >
                {value.state === '' && (
                  <option value="" disabled>
                    State
                  </option>
                )}
                {AU_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {label('postcode')}
            <input
              ref={postcodeRef}
              id={ids.postcode}
              type="text"
              inputMode="numeric"
              value={value.postcode}
              required={required}
              {...unlabelled('postcode')}
              {...turnAutofillAway}
              onChange={(e) => {
                const next = e.target.value
                hide('postcode')
                // Four digits is a finished postcode: its issues show after
                // the pause, without waiting for the field to be left.
                if (/^\d{4}$/.test(next.trim())) {
                  showOnCheck.current.add('postcode')
                } else showOnCheck.current.delete('postcode')
                // Put right (or cleared), the error goes until next left.
                if (addressErrors({ ...now, postcode: next }).length === 0) {
                  setPostcodeErrorShown(false)
                }
                onChange({ postcode: next })
              }}
              onBlur={() => {
                setPostcodeErrorShown(blocking !== null)
                show(['postcode'])
              }}
              onInvalid={() => setPostcodeErrorShown(true)}
              aria-invalid={showPostcodeError || undefined}
              aria-describedby={describedBy(
                showPostcodeError && postcodeErrorId,
                (postcodeIssues.length > 0 || keptPostcode) &&
                  postcodeWarningId,
              )}
              className={fieldInputClass(size, showPostcodeError)}
            />
          </div>
        </div>

        {/* Under the pair rather than in its half-width column, where a
            sentence would wrap every two words on a phone. */}
        {showPostcodeError && (
          <FieldMessage
            id={postcodeErrorId}
            tone="error"
            fix={
              blocking.fix
                ? {
                    label: blocking.fix.label,
                    onApply: () => applyFix(blocking.fix?.patch ?? {}),
                  }
                : undefined
            }
          >
            {blocking.message}
          </FieldMessage>
        )}
        <Warnings id={stateWarningId} issues={stateIssues} fix={applyFix} />
        <Warnings
          id={postcodeWarningId}
          issues={
            keptPostcode ? [keptPostcode, ...postcodeIssues] : postcodeIssues
          }
          fix={applyFix}
        />

        {/* Always in the page, so screen readers hear each change of it. */}
        <p
          id={statusId}
          role="status"
          className={`mt-1.5 flex items-center gap-1.5 text-caption empty:mt-0 ${streetStatus === 'found' ? 'text-green-ink' : 'text-grey-ink'}`}
        >
          {streetStatus === 'found' && (
            <>
              <Check aria-hidden className="size-3.5 shrink-0" />
              Street found
            </>
          )}
          {streetStatus === 'checking' && 'Checking…'}
          {streetStatus === 'no-signal' && 'Not checked — no signal'}
        </p>
      </div>
    </>
  )
}

/** The fields the offline check reads, as one string: a new street name
 * changes nothing it says. */
function offlineKeyOf(value: AddressValue): string {
  return [value.suburb.trim(), value.state.trim(), value.postcode.trim()].join(
    '\n',
  )
}

/** A field's warnings, each with its fix, under one id for the field's
 * aria-describedby. Nothing when there are none. */
function Warnings({
  id,
  issues,
  fix,
}: {
  id: string
  issues: ReadonlyArray<AddressIssue>
  fix: (patch: Partial<AddressValue>) => void
}): ReactNode {
  if (issues.length === 0) return null
  return (
    <div id={id}>
      {issues.map((issue) => {
        const patch = issue.fix?.patch
        return (
          <FieldMessage
            key={issue.message}
            tone="warning"
            fix={
              issue.fix && patch
                ? { label: issue.fix.label, onApply: () => fix(patch) }
                : undefined
            }
          >
            {issue.message}
          </FieldMessage>
        )
      })}
    </div>
  )
}
