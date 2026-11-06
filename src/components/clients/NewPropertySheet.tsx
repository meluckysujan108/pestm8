import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { convexQuery, useConvexMutation } from '@convex-dev/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { Drawer } from 'vaul'
import {
  SHEET_BODY,
  SheetLock,
  SheetShell,
} from '#/components/primitives/Sheet'
import { api } from '../../../convex/_generated/api'
import { FormAlert } from '#/components/forms/FormAlert'
import { FieldMessage } from '#/components/forms/FieldMessage'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveCheck,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import type { SaveWarning } from '#/components/forms/SaveWarnings'
import {
  EMPTY_NEW_CLIENT,
  NEW_CLIENT_ERROR_COPY,
  NewClientFields,
  newClientArgs,
} from './NewClientFields'
import type {
  NewClientArgs,
  NewClientFieldsValue,
  NewClientMatchField,
  NewClientMatchLine,
  SiteAddressDraft,
} from './NewClientFields'
import { useAccess } from '#/lib/access'
import { normaliseDirectory } from '#/lib/directory'
import { rq } from '#/lib/routeQueries'
import { useMatchIndexWhenRead } from '#/lib/useMatchIndex'
import {
  blurLine,
  bookingDismissed,
  candidateHeld,
  matchFooter,
  matchName,
  matchNotes,
  matchShownCounts,
  newClientRows,
  noClientsIndex,
  openFromNewClient,
  openUnheld,
  refusedMatchRows,
} from '#/lib/clientMatchRows'
import type {
  MatchFix,
  MatchRow,
  MatchRowsContext,
} from '#/lib/clientMatchRows'
import { logConnection, logConnectionChange } from '#/lib/connectionLog'
import {
  FOUND_WHEN_SAVING,
  createHoldWait,
  createPressReads,
  joinSends,
  matchCheckFor,
  sendChecked,
  sendsByRow,
  standingSends,
} from '#/lib/sheetChecks'
import type { PressNote, SheetRefusal, SheetSends } from '#/lib/sheetChecks'
import { todayKey } from '#/lib/format'
import { keeper } from '#/lib/offline/keeper'
import { answerMayBeBehind } from '#/lib/offline/useKept'
import type { Id } from '../../../convex/_generated/dataModel'
import { useHydrated } from '#/lib/useHydrated'
import { useLineDown } from '#/lib/offline/useLineDown'
import type { LineDown } from '#/lib/offline/useLineDown'
import { HELD_BUTTON, PRIMARY_BUTTON } from '#/components/primitives/buttons'

/**
 * Above Save client while the line is down (lib/offline/useLineDown.ts):
 * the save isn't refused, it waits in the Convex client until the line is
 * back, for as long as the app stays open.
 */
const SAVE_WAITS: Record<LineDown, string> = {
  'no-signal':
    'No signal — the client is saved when you have signal. Keep PestM8 open until then.',
  unreachable:
    'Could not reach PestM8 — it’s saved once it can. Keep PestM8 open until then.',
}

/**
 * Above the fields when New client opens on what was kept as an Open
 * {client} left (`openFromNewClient`'s `keepDraft`): the next caller is
 * someone else, and is never saved with the last one's details unseen.
 */
export function KeptDraftNote({
  from,
  onClear,
}: {
  /** The client opened then, as a row names them. */
  from: string
  onClear: () => void
}) {
  return (
    <FieldMessage
      tone="status"
      className="mt-2"
      fix={{ label: 'Clear', onApply: onClear }}
    >
      Still filled in from before you opened {from}.
    </FieldMessage>
  )
}

/**
 * A check at Save made before the client list is read: waits in `waiting`,
 * and is answered as the list comes (`answer`, the rows for what is typed
 * then), unless the press gave up on it first (`signal`: the 3 s any check
 * at Save is given). Then it finds nothing: those rows were never shown,
 * and aren't noted as shown either (`match-shown`), as that would cost the
 * note of the press that does show them.
 */
export function answerOnceRead(
  waiting: Array<() => void>,
  signal: AbortSignal,
  answer: () => Array<SaveWarning>,
): Promise<Array<SaveWarning>> {
  return new Promise((resolve) => {
    waiting.push(() => resolve(signal.aborted ? [] : answer()))
  })
}

/**
 * Whether New client keeps what was typed after an Open {client}: where
 * something in it went nowhere (`openFromNewClient`), and where an address
 * went with the open with no signal. Their sheet is then the copy kept on
 * the phone, which adds no site, so closed before signal is back, Add
 * property never opens on it, and the address the caller gave would be
 * nowhere. Kept, New client says so (`KeptDraftNote`).
 */
export function keepsDraftAfterOpen(
  opened: { keepDraft: boolean; addSite?: SiteAddressDraft },
  lineDown: LineDown | null,
): boolean {
  return opened.keepDraft || (opened.addSite !== undefined && lineDown !== null)
}

/** The client as typed, as the matcher reads it. */
function typedOf(value: NewClientFieldsValue) {
  return {
    name: value.clientName,
    phone: value.phone,
    email: value.email,
    site: {
      addressLine: value.addressLine,
      suburb: value.suburb,
      postcode: value.postcode,
    },
  }
}

/**
 * Creates a client and its first property together in one step — a client
 * without at least one address is meaningless in this domain, so splitting
 * "new client" from "add first property" into two screens would cost a step
 * for zero benefit.
 *
 * Whether they are a client already is checked as in New Job (the matching
 * plan's §2.10), from the client list without waiting for it: at Save, and
 * under Name, Phone and Email as they are left. Nothing is booked here, so
 * every fix is Open {client}: this sheet closes and theirs opens
 * (`onOpenClient`), on Add property with the address typed (a business's
 * with the caller as its site contact), unless the address is theirs
 * already or the row only shows who the caller may be. What was typed is
 * kept for New client again unless all of it went with the open or is
 * theirs already (`openFromNewClient`), and kept with no signal whenever an
 * address went with it (`keepsDraftAfterOpen`).
 */
export function NewPropertySheet({
  businessId,
  open,
  onClose,
  onOpenClient,
}: {
  businessId: Id<'businesses'>
  open: boolean
  onClose: () => void
  /** Opens a client's sheet over the page, with Add property open on
   * `addSite` when given. Without it, a match is said with no fix. */
  onOpenClient?: (
    clientId: Id<'clients'>,
    opts: { addSite?: SiteAddressDraft },
  ) => void
}) {
  const business = useRouteContext({
    from: '/$businessSlug',
    select: (context) => context.business,
  })
  const businessState = business.state
  // Starts in the business's own state, as "Add another property" does: a
  // Darwin address typed by hand and left on WA is how prod came to hold
  // "Fannybay WA".
  const empty: NewClientFieldsValue = {
    ...EMPTY_NEW_CLIENT,
    state: businessState || EMPTY_NEW_CLIENT.state,
  }
  const [value, setValue] = useState<NewClientFieldsValue>(empty)
  // Who was opened when what was typed was kept (`KeptDraftNote`), until
  // it is cleared, saved or discarded.
  const [keptFrom, setKeptFrom] = useState<string | null>(null)
  // Read when the save runs, which may be after the checks at Save have
  // answered: what was typed while they ran is what gets saved.
  const latestValue = useLatest(value)
  // Which draft this is: each blanking of the form starts the next
  // (`clear`), and a save goes with the draft it was pressed for.
  const draftNo = useRef(0)

  const hydrated = useHydrated()
  const lineDown = useLineDown()
  const lineDownId = useId()
  // The address, email and phone checks at Save: what may be wrong is listed
  // above the button, and a second press saves it as it is. Save takes no
  // press for half a second as the list comes in under the thumb.
  const saveWarnings = useSaveWarnings({ arm: true })

  // The client list and the roster, read without waiting, and only while
  // the sheet is open: the Clients page behind it holds no whole book, and
  // a closed sheet must not subscribe it to one ('skip', since a query only
  // disabled keeps its subscription). Until they are here, a field left has
  // its line once they come (NewClientFields), and a press of Save waits for
  // them, up to the 3 s any check at Save is given. The server looks again
  // as the client is saved (`matchCheck`, the matching plan's M7): what it
  // finds that this list didn't is said as rows of their own.
  const { data: answer } = useQuery(
    convexQuery(api.clients.directory, open ? { businessId } : 'skip'),
  )
  const directory = useMemo(
    () => (answer ? normaliseDirectory(answer) : undefined),
    [answer],
  )
  const { data: members } = useQuery(
    convexQuery(
      api.memberships.listForBusiness,
      open ? { businessId } : 'skip',
    ),
  )
  const access = useAccess()
  const index = useMatchIndexWhenRead(directory, business, members, access)
  const matchCtx = useMemo<MatchRowsContext | null>(
    () =>
      index && directory
        ? { index, contacts: directory.contacts, verb: 'open' }
        : null,
    [index, directory],
  )
  // Open {client}, as it is tapped, whether the fix was a row at Save or a
  // line under a field: Add property on the address typed by then, unless
  // none is, it is theirs, or the caller may be someone else; and New
  // client kept as typed when something in it went nowhere
  // (`openFromNewClient`).
  const latestOpen = useLatest((fix: MatchFix) => {
    if (fix.kind !== 'open' || !onOpenClient) return
    const form = latestValue.current
    const typed = {
      name: form.clientName,
      phone: form.phone,
      email: form.email,
      addressLine: form.addressLine,
      suburb: form.suburb,
      state: form.state,
      postcode: form.postcode,
      addressCheck: form.addressCheck,
      // A business's, as the form shows them (`newClientArgs`).
      ...(form.kind === 'business' && {
        abn: form.abn,
        contactPerson: form.contactPerson,
        siteContactName: form.siteContactName,
        siteContactPhone: form.siteContactPhone,
      }),
    }
    // A client the server found that the list on the phone isn't holding
    // yet (`refusedMatchRows`): their sheet, opened by the server's id, on
    // Add property with the address typed where it isn't theirs, with New
    // client kept as typed (`openUnheld`).
    const opened =
      !index || !directory
        ? openUnheld(fix, typed)
        : openFromNewClient(index, directory.contacts, fix, typed)
    if (keepsDraftAfterOpen(opened, lineDown)) {
      saveWarnings.reset()
      const held = index?.clients.get(fix.clientId)
      setKeptFrom(held || !fix.name ? matchName(held) : fix.name)
      onClose()
    } else close()
    onOpenClient(fix.clientId, { addSite: opened.addSite })
  })
  const fixFor = (fix: MatchFix | undefined) =>
    fix && onOpenClient
      ? { label: fix.label, apply: () => latestOpen.current(fix) }
      : undefined
  // Where the rows were found, said once as they appear: "From the clients
  // on this phone, updated 9:42am.", as New Job says it; and the rows, by
  // id, for the foot to name the fix that is there (`matchFooter`).
  const [matchShown, setMatchShown] = useState<{
    notes: Array<string>
    rows: ReadonlyMap<string, MatchRow>
  }>({ notes: [], rows: new Map() })

  // What each press's check found, as it answered: what its save sends
  // (`matchCheckNow`).
  const [pressReads] = useState(() =>
    createPressReads<{ dismissed: ReadonlyArray<Id<'clients'>> }>(),
  )

  /** The rows at Save for the client as typed, from the client list; and
   * every client the matcher returned, noted for the press (`note`). */
  function matchWarnings(
    ctx: MatchRowsContext,
    note: PressNote<{ dismissed: ReadonlyArray<Id<'clients'>> }>,
  ): Array<SaveWarning> {
    const typed = latestValue.current
    const rows = newClientRows(ctx, {
      name: typed.clientName,
      phone: typed.phone,
      email: typed.email,
      site: {
        addressLine: typed.addressLine,
        suburb: typed.suburb,
        postcode: typed.postcode,
      },
    })
    note(
      'dismissed',
      bookingDismissed(ctx, { mode: 'new', typed: typedOf(typed) }),
    )
    if (rows.length > 0) {
      const directoryKey = rq.directory(businessId).queryKey
      setMatchShown({
        notes: matchNotes({
          behind: answerMayBeBehind(directoryKey),
          asOf: keeper.asOf([directoryKey]),
          timezone: business.timezone,
          today: todayKey(business.timezone),
          capped: directory?.capped ?? false,
          contactsCapped: directory?.contactsCapped ?? false,
        }),
        rows: new Map(rows.map((row) => [row.id, row])),
      })
      logConnectionChange('match-shown', {
        ...matchShownCounts(rows),
        live: keeper.isLive(directoryKey),
      })
    }
    return rows.map((row) => {
      const fix = fixFor(row.fix)
      return {
        id: row.id,
        kind: 'match',
        label: row.label,
        message: row.message,
        ...(fix ? { fix } : {}),
      }
    })
  }
  const latestMatchWarnings = useLatest(matchWarnings)
  const latestMatchCtx = useLatest(matchCtx)
  // Presses of Save waiting for the client list, answered as it comes.
  const waitingForList = useRef<Array<() => void>>([])
  useEffect(() => {
    if (!matchCtx) return
    const waiting = waitingForList.current
    waitingForList.current = []
    for (const go of waiting) go()
  }, [matchCtx])

  useSaveCheck(
    'new-client-match',
    matchCtx
      ? (signal) => matchWarnings(matchCtx, pressReads.begin(signal))
      : (signal) => {
          const note = pressReads.begin(signal)
          return answerOnceRead(waitingForList.current, signal, () => {
            const ctx = latestMatchCtx.current
            return ctx ? latestMatchWarnings.current(ctx, note) : []
          })
        },
    [
      value.clientName,
      value.phone,
      value.email,
      value.addressLine,
      value.suburb,
      value.postcode,
    ],
    // This form's own: the provider is rendered below, by this component.
    saveWarnings,
  )
  const matchLine = (
    field: NewClientMatchField,
    typed: NewClientFieldsValue,
  ): NewClientMatchLine | null => {
    if (!matchCtx) return null
    const line = blurLine(matchCtx, field, {
      name: typed.clientName,
      phone: typed.phone,
      email: typed.email,
      site: {
        addressLine: typed.addressLine,
        suburb: typed.suburb,
        postcode: typed.postcode,
      },
    })
    if (!line) return null
    const fix = line.fix && onOpenClient ? line.fix : undefined
    return {
      text: line.text,
      ...(fix
        ? { fix: { label: fix.label, onApply: () => latestOpen.current(fix) } }
        : {}),
      ...(line.nameFree ? { nameFree: true as const } : {}),
    }
  }

  // Closed with nothing typed, or with what was typed discarded (the sheet
  // asks first: SheetLock below). Either way it opens empty next time, and
  // warnings about a draft walked away from are not news then. Only Open
  // {client} closes it keeping what was typed, when some of it went nowhere,
  // and it says so as it opens again (`KeptDraftNote`).
  function close() {
    clear()
    onClose()
  }

  /** Blank again, a new draft: what was kept is for no one now, and a
   * press still waiting for the client list is for nothing. So is a save
   * still out: the sheet stays mounted while closed, so without
   * `create.reset()` its error would show in FormAlert above the next
   * draft, and its "Saving…" on the button, until the next Save. Reset,
   * Save takes the next draft's press while that save may still be
   * waiting for signal, so what it does as it answers is tied to its own
   * draft (`draftNo`): a refusal of it never goes on the next draft's
   * panel (once that draft's press has begun, `inject` alone can't tell),
   * and its success neither blanks nor closes the next draft. */
  function clear() {
    draftNo.current += 1
    saveWarnings.reset()
    create.reset()
    waitingForList.current = []
    setValue(empty)
    setKeptFrom(null)
  }

  // ── What the server found as the client was saved (M7) ──────────────
  // A refusal's rows, by id, for the foot; what they send back as
  // dismissed with the next press, read as the save goes; and the refusal
  // whose rows are on the panel, which FormAlert doesn't say again.
  const [refused, setRefused] = useState<ReadonlyMap<string, MatchRow>>(
    new Map(),
  )
  const refusedSends = useRef<ReadonlyMap<string, SheetSends>>(new Map())
  const [shownRefusal, setShownRefusal] = useState<unknown>(null)
  // Asked again as the list's answers land, and after every edit, once the
  // check above has told the panel of it (each commit: its effect runs
  // before this one), so a wait whose rows the panel would turn down ends.
  const [holdWait] = useState(createHoldWait)
  useEffect(() => holdWait.poke())

  /** Every client the phone's matcher found for the client as typed at
   * the press, as its check answered (`pressReads`: none where it found
   * nothing in time), never the list read again as the save goes; and
   * every one a refusal named that is still on the panel (`extra`: one an
   * earlier send of this press was refused for). */
  function matchCheckNow(extra: SheetSends) {
    const dismissed = pressReads.last().dismissed ?? []
    const standing = standingSends(
      refusedSends.current,
      saveWarnings.refusedNow(),
    )
    return matchCheckFor([
      ...dismissed,
      ...joinSends(extra, standing).dismissed,
    ])
  }
  const latestMatchCheck = useLatest(matchCheckNow)
  const latestHeld = useLatest(
    (refusal: SheetRefusal) =>
      refusal.code !== 'MATCHED_CLIENT' ||
      (index !== null &&
        refusal.candidates.every((c) => candidateHeld(index, c))),
  )
  /** A refusal's rows, every fix Open {client} by the server's id. */
  const latestRefusalRows = useLatest((refusal: SheetRefusal) => {
    const source = 'new-client-match'
    if (refusal.code !== 'MATCHED_CLIENT') return { source, rows: [] }
    const ctx: MatchRowsContext = matchCtx ?? {
      index: noClientsIndex(),
      contacts: [],
      verb: 'open',
    }
    const rows = refusedMatchRows(ctx, refusal, {
      mode: 'new',
      typed: typedOf(latestValue.current),
    })
    return {
      source,
      rows: rows.map((row) => {
        const fix = fixFor(row.fix)
        return {
          id: row.id,
          kind: 'match' as const,
          label: row.label,
          message: row.message,
          ...(fix ? { fix } : {}),
          foot: row,
        }
      }),
    }
  })
  const latestShowRefusal = useLatest(
    (
      source: string,
      rows: ReadonlyArray<SaveWarning & { foot: MatchRow }>,
      sends: SheetSends,
      error: unknown,
    ) => {
      const before = saveWarnings.refusedNow()
      const shown = rows.length > 0 && saveWarnings.inject(source, rows)
      logConnection('sheet-refused', {
        code: 'MATCHED_CLIENT',
        rows: rows.length,
        shown,
      })
      if (!shown) return
      refusedSends.current = sendsByRow(
        refusedSends.current,
        before,
        source,
        rows,
        sends,
      )
      setRefused((feet) => {
        const next = new Map(feet)
        for (const row of rows) next.set(row.id, row.foot)
        return next
      })
      setShownRefusal(error)
    },
  )

  const convexCreate = useConvexMutation(api.properties.create)
  const create = useMutation({
    // With the check at Save (`matchCheck`, M7): what the server finds
    // beyond it is said as rows, and Save anyway sends them back as
    // dismissed (lib/sheetChecks.ts `sendChecked`). "Saving…" stays while
    // their fixes wait for the client list to hold who they open. The
    // draft it was pressed for (`draftNo`) goes no further than here.
    mutationFn: ({
      draft,
      ...args
    }: { draft: number; businessId: Id<'businesses'> } & NewClientArgs) =>
      sendChecked({
        send: (extra) =>
          convexCreate({
            ...args,
            matchCheck: latestMatchCheck.current(extra),
          }),
        rowsOf: (refusal) => latestRefusalRows.current(refusal),
        // Until the list holds who they open, or the panel would turn the
        // rows down (`mayShow`, below: an edit, a draft begun since).
        hold: (refusal, turnedDown) =>
          holdWait.until(() => turnedDown() || latestHeld.current(refusal)),
        // Rows the panel would turn down wait for nothing.
        mayShow: (source) =>
          draft === draftNo.current && saveWarnings.mayInject(source),
        listed: saveWarnings.listedNow,
        // Not on a draft begun since (`clear`).
        inject: (source, rows, sends, error) => {
          if (draft !== draftNo.current) return
          latestShowRefusal.current(source, rows, sends, error)
        },
      }),
    onSuccess: (_saved, { draft }) => {
      if (draft !== draftNo.current) return
      setValue(empty)
      setKeptFrom(null)
      onClose()
    },
  })
  // Rows a refusal put on the panel: the server's, so the note about the
  // copy on the phone isn't theirs; theirs is FOUND_WHEN_SAVING.
  const fromServer = new Set(saveWarnings.injected.map((w) => w.id))
  const showsPhoneRows = saveWarnings.warnings.some(
    (w) => w.kind === 'match' && !fromServer.has(w.id),
  )
  const showsRefused = saveWarnings.warnings.some((w) => fromServer.has(w.id))
  const panelNote = [
    ...(showsPhoneRows ? matchShown.notes : []),
    ...(showsRefused ? [FOUND_WHEN_SAVING] : []),
  ]

  return (
    <SheetShell open={open} onClose={close}>
      {/* Anything typed locks the sheet against a swipe, and ✕ asks. */}
      <SheetLock
        changed={JSON.stringify(value) !== JSON.stringify(empty)}
        whileUnchanged={false}
      />
      <SaveWarningsProvider value={saveWarnings}>
        <form
          className={`${SHEET_BODY} pt-3`}
          onSubmit={(e) =>
            // mutateAsync, so a save that fails keeps the warnings already
            // confirmed and Retry does not ask about them again.
            saveWarnings.guard(e, () =>
              create.mutateAsync({
                draft: draftNo.current,
                businessId,
                ...newClientArgs(latestValue.current),
              }),
            )
          }
        >
          <Drawer.Title className="text-sheet-title text-ink">
            New client
          </Drawer.Title>
          {keptFrom !== null && (
            <KeptDraftNote from={keptFrom} onClear={clear} />
          )}

          <NewClientFields
            value={value}
            onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
            businessState={businessState}
            // Only once there is a client list to decide it from: a field
            // left before then has its line as the list comes.
            matchLine={matchCtx ? matchLine : undefined}
          />

          {/* Not for a refusal whose rows the panel shows: they say it. */}
          <FormAlert
            error={
              create.isError && create.error !== shownRefusal
                ? create.error
                : null
            }
            copy={NEW_CLIENT_ERROR_COPY}
            className="mt-3"
          />
          <SaveWarningsPanel
            className="mt-3"
            matchFooter={(shown) =>
              matchFooter(
                // Without a way to open the client, no row has a fix.
                shown.map((w) =>
                  onOpenClient
                    ? ((fromServer.has(w.id)
                        ? refused.get(w.id)
                        : matchShown.rows.get(w.id)) ?? {})
                    : {},
                ),
                { anyway: 'Save anyway', adds: 'client' },
              )
            }
            note={panelNote.length > 0 ? panelNote.join(' ') : undefined}
          />

          <div className="mt-5">
            {lineDown && (
              <p id={lineDownId} className="mb-2 text-caption text-ink-2">
                {SAVE_WAITS[lineDown]}
              </p>
            )}
            <button
              type="submit"
              disabled={create.isPending || !hydrated}
              aria-disabled={saveWarnings.armed || undefined}
              aria-describedby={lineDown ? lineDownId : undefined}
              className={`${PRIMARY_BUTTON} ${HELD_BUTTON} w-full`}
            >
              {create.isPending
                ? 'Saving…'
                : saveWarnings.saveLabel('Save client')}
            </button>
          </div>
        </form>
      </SaveWarningsProvider>
    </SheetShell>
  )
}
