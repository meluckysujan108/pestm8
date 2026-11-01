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
  matchFooter,
  matchName,
  matchNotes,
  matchShownCounts,
  newClientRows,
  openFromNewClient,
} from '#/lib/clientMatchRows'
import type {
  MatchFix,
  MatchRow,
  MatchRowsContext,
} from '#/lib/clientMatchRows'
import { logConnectionChange } from '#/lib/connectionLog'
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
 * theirs already (`openFromNewClient`).
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
  // them, up to the 3 s any check at Save is given: until the online sheet
  // sends its check with the booking (the matching plan's M7), the server
  // doesn't look for the caller among the clients, so this is the only
  // check there is.
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
    if (fix.kind !== 'open' || !onOpenClient || !index || !directory) return
    const typed = latestValue.current
    const opened = openFromNewClient(index, directory.contacts, fix, {
      name: typed.clientName,
      phone: typed.phone,
      email: typed.email,
      addressLine: typed.addressLine,
      suburb: typed.suburb,
      state: typed.state,
      postcode: typed.postcode,
      addressCheck: typed.addressCheck,
      // A business's, as the form shows them (`newClientArgs`).
      ...(typed.kind === 'business' && {
        abn: typed.abn,
        contactPerson: typed.contactPerson,
        siteContactName: typed.siteContactName,
        siteContactPhone: typed.siteContactPhone,
      }),
    })
    if (opened.keepDraft) {
      saveWarnings.reset()
      setKeptFrom(matchName(index.clients.get(fix.clientId)))
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

  /** The rows at Save for the client as typed, from the client list. */
  function matchWarnings(ctx: MatchRowsContext): Array<SaveWarning> {
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
      ? () => matchWarnings(matchCtx)
      : (signal) =>
          answerOnceRead(waitingForList.current, signal, () => {
            const ctx = latestMatchCtx.current
            return ctx ? latestMatchWarnings.current(ctx) : []
          }),
    [
      value.clientName,
      value.phone,
      value.email,
      value.addressLine,
      value.suburb,
      value.postcode,
    ],
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

  /** Blank again: what was kept is for no one now, and a press still
   * waiting for the client list is for nothing. */
  function clear() {
    saveWarnings.reset()
    waitingForList.current = []
    setValue(empty)
    setKeptFrom(null)
  }

  const convexCreate = useConvexMutation(api.properties.create)
  const create = useMutation({
    mutationFn: (args: { businessId: Id<'businesses'> } & NewClientArgs) =>
      convexCreate(args),
    onSuccess: () => {
      setValue(empty)
      setKeptFrom(null)
      onClose()
    },
  })

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

          <FormAlert
            error={create.isError ? create.error : null}
            copy={NEW_CLIENT_ERROR_COPY}
            className="mt-3"
          />
          <SaveWarningsPanel
            className="mt-3"
            matchFooter={(shown) =>
              matchFooter(
                // Without a way to open the client, no row has a fix.
                shown.map((w) =>
                  onOpenClient ? (matchShown.rows.get(w.id) ?? {}) : {},
                ),
                { anyway: 'Save anyway', adds: 'client' },
              )
            }
            note={
              saveWarnings.warnings.some((w) => w.kind === 'match') &&
              matchShown.notes.length > 0
                ? matchShown.notes.join(' ')
                : undefined
            }
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
