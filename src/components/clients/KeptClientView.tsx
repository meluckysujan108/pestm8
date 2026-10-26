import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Drawer } from 'vaul'
import { WifiOff } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { ContactButtons } from '#/components/primitives/ContactButtons'
import { DetailRow, DetailRows } from '#/components/primitives/DetailRow'
import {
  ClientStatusPill,
  TagChips,
  clientNumberLabel,
} from '#/components/clients/ClientRecordBits'
import { UnseenEdit, UnseenMenu } from '#/components/schedule/KeptJobView'
import { KIND_LABELS } from '#/lib/clientFilters'
import { logConnection } from '#/lib/connectionLog'
import { formatUpdated } from '#/lib/format'
import { keeper } from '#/lib/offline/keeper'
import {
  NOT_KEPT_CLIENT,
  OPENS_WITH_SIGNAL,
  findKeptClient,
  keptClientEmail,
  keptClientState,
  xeroKnown,
} from '#/lib/offline/keptClient'
import { KEPT_JOB_WAIT_MS, keptJobInset } from '#/lib/offline/keptJob'
import { argsOf } from '#/lib/offline/keptSet'
import {
  useKeeperReads,
  useLineDown,
  useReadable,
  useWaitedOut,
} from '#/lib/offline/useKept'
import { rq } from '#/lib/routeQueries'
import { dayKeyOf } from '../../../convex/lib/dates'
import { siteContactOf } from '../../../convex/lib/siteContact'
import type { ReactNode } from 'react'
import type { DirectoryClient, DirectorySite } from '#/lib/directory'
import type { LineDown } from '#/lib/offline/keeper'
import type { KeptClient, KeptClientState } from '#/lib/offline/keptClient'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * Whether the client sheet shows the client from the phone's client list
 * (`keptClientState`), and their row there. Looked for as the job sheet
 * looks for its job (`useKeptJob`): once the line is down, or once PestM8
 * has been asked for KEPT_JOB_WAIT_MS with no answer (and, once shown,
 * until the answer comes), while `clients.get` has neither answered nor been
 * refused. Then the client list is read, which with no answer comes from
 * memory, or from the phone's copy as it would answer for this person,
 * business and view (`keeper.wrap`), and nothing else.
 *
 * `asOf`: when the list was last known right (`keeper.asOf`), or with it
 * still live, when the server last spoke. `xero`: whether the live sheet
 * would have a Xero row, as far as memory shows (`xeroKnown`). `email`:
 * theirs, from a day's row for a visit of theirs (`keptClientEmail`), for
 * the Email the live sheet has beside Call: looked for as the client first
 * shows, and kept while they do, so it never joins Call and Text later,
 * narrowing them under a thumb.
 */
export function useKeptClient(
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
  waiting: boolean,
): {
  state: KeptClientState
  kept: KeptClient | null
  asOf: number
  down: LineDown | null
  xero: boolean
  email: string | undefined
} {
  const queryClient = useQueryClient()
  const down = useLineDown()
  const waitedOut = useWaitedOut(waiting, down, KEPT_JOB_WAIT_MS)
  // Latched once shown, so a line that comes back before the answer does
  // doesn't put the placeholder back over a client already on screen.
  const [shown, setShown] = useState(false)
  const looking = waiting && (down !== null || waitedOut || shown)
  const directoryKey = rq.directory(businessId).queryKey
  const directoryQuery = useQuery(
    convexQuery(api.clients.directory, looking ? { businessId } : 'skip'),
  )
  const directory = looking ? directoryQuery.data : undefined
  const listReadable = useReadable(directoryKey)
  const live = looking && keeper.isLive(directoryKey)

  const kept = directory ? findKeptClient(directory, clientId) : null
  const state = looking
    ? keptClientState({
        down,
        waitedOut,
        shown,
        found: kept !== null,
        live,
        listed: directory !== undefined,
        listReadable,
      })
    : 'waiting'
  useEffect(() => {
    if (state === 'kept') setShown(true)
  }, [state])
  const [email, setEmail] = useState<{ value: string | undefined } | null>(null)
  const nextEmail =
    email === null && state === 'kept' && kept !== null
      ? {
          value: keptClientEmail(kept.sites, (match) =>
            keeper.findDayRowWhere(match),
          ),
        }
      : email
  if (nextEmail !== email) setEmail(nextEmail)
  useKeeperReads(waiting, state === 'waiting' && kept !== null && live)

  // For the phone's connection notes: a client asked for that the phone
  // doesn't keep, once for each sheet opened.
  const noted = useRef(false)
  useEffect(() => {
    if (state !== 'not-kept' || noted.current) return
    noted.current = true
    logConnection('kept-not-here', { what: 'client' })
  }, [state])

  const xero =
    state === 'kept' &&
    xeroKnown({
      lines: queryClient
        .getQueryCache()
        .findAll({ queryKey: ['convexQuery', 'xeroSync:clientLines'] })
        .filter((query) => argsOf(query.queryKey)?.businessId === businessId)
        .map((query) => query.state.data),
      status: queryClient.getQueryData(rq.xeroStatus(businessId).queryKey),
    })

  return {
    state,
    kept,
    // While the list is still live, the server's last word, as the job
    // sheet has it (`findDayRow`); the phone's clock only where neither is
    // known, which a list on screen never is.
    asOf: keeper.asOf([directoryKey]) ?? keeper.heardAt() ?? Date.now(),
    down,
    xero,
    email: nextEmail?.value,
  }
}

/**
 * A client opened with no answer from PestM8 (the line down, or the answer
 * late), shown read-only from the phone's client list (`useKeptClient`), in
 * place of the client sheet until PestM8 answers. What a technician needs at
 * the door: who they are, their number, Call and Text (and Email where a day
 * the phone holds says it), and each site with Map and its site contact.
 * Their jobs, notes, contacts and Xero aren't kept, and each says it opens
 * when there is signal (Xero only where the live sheet would have a row for
 * it). Nothing here changes anything: no Edit, no status to change, no site
 * to add.
 *
 * Drawn in the sheet's own scrolling body, the one the live sheet is drawn
 * in (ClientSheet.tsx, `useHandOverBody`), which keeps its scroll and its
 * height when the live sheet takes this one's place. Down to Call, Text and
 * Email it is laid out as the live sheet is, line for line, Edit's row and
 * the status menu's chevron held unseen, and the line saying why comes after
 * them: when PestM8 answers, Call is where it was, under the thumb that may
 * be on it. Where the client has an email no day the phone holds says, the
 * live sheet's Email joins Call and Text, and all three narrow.
 *
 * Typed from `clients.directory`'s rows rather than `clients.get`'s: a
 * change to the list's fields shows here as a type error, not as a sheet
 * missing a line.
 */
export function KeptClientView({
  client,
  sites,
  asOf,
  down,
  timezone,
  xero = false,
  email,
}: {
  client: DirectoryClient
  /** Their sites, oldest first, as the client list has them. */
  sites: ReadonlyArray<DirectorySite>
  /** When the client list was last known right (`useKeptClient`). */
  asOf: number
  down: LineDown | null
  timezone: string
  /** The live sheet would have a Xero row (`xeroKnown`): it says it opens
   * with signal. Where Xero isn't set up the live sheet has none, nor does
   * this. */
  xero?: boolean
  /** Theirs, from a day's row (`useKeptClient`): Email beside Call and
   * Text, as on the live sheet. */
  email?: string
}) {
  // Drawn only in the browser, with the line down, so the phone's clock
  // gives today here.
  const todayKey = dayKeyOf(Date.now(), timezone)
  const number = clientNumberLabel(client.clientNumber)

  return (
    <>
      {/* A client's number heads their sheet, as on the live one, in the
          row the live one shares with Edit, which holds its place unseen. */}
      <div className="flex items-center justify-between gap-2">
        <p className="section-label mb-0.5 tabular-nums">
          {number !== null ? `Client ${number}` : 'Client'}
        </p>
        <UnseenEdit />
      </div>
      <Drawer.Title className="text-sheet-title text-ink">
        {client.name}
      </Drawer.Title>

      {/* As wide as the live sheet's status menu, so the type beside it
          wraps where the live one does. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <UnseenMenu>
          <ClientStatusPill status={client.status} />
        </UnseenMenu>
        <span className="text-body text-muted">{KIND_LABELS[client.kind]}</span>
      </div>
      {client.tags && client.tags.length > 0 && (
        <div className="mt-2">
          <TagChips tags={client.tags} />
        </div>
      )}

      {/* Call, Text and Email, as the live sheet has them. */}
      {(client.phone || email) && (
        <div className="mt-3">
          <ContactButtons
            name={client.name}
            phone={client.phone}
            email={email}
          />
        </div>
      )}

      {/* The job sheet's line with no signal, word for word: under Call,
          Text and Email, which stay where the live sheet has them. */}
      <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-caption text-ink-2">
        <WifiOff
          aria-hidden
          size={14}
          strokeWidth={2}
          className="mt-0.5 shrink-0"
        />
        {keptJobInset(down, formatUpdated(asOf, timezone, todayKey))}
      </p>

      <Section label="Properties">
        {sites.length === 0 ? (
          <p className="text-body text-muted">No properties yet</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {sites.map((site) => (
              <div
                key={site._id}
                className="rounded-2xl border border-hairline bg-surface p-3"
              >
                <p className="text-body text-ink-2">{site.addressLine}</p>
                <p className="text-caption text-muted">
                  {site.suburb} {site.postcode}
                </p>
                <div className="mt-3">
                  <ContactButtons
                    name={site.addressLine}
                    address={site}
                    show={['map']}
                  />
                </div>
                <KeptSiteContact clientKind={client.kind} site={site} />
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section label="Details" card>
        <DetailRows>
          <DetailRow label="Client number" value={number ?? 'None'} />
          {client.phone && (
            <DetailRow
              label="Phone"
              value={<span className="select-text">{client.phone}</span>}
            />
          )}
          {email && (
            <DetailRow
              label="Email"
              value={<span className="select-text">{email}</span>}
            />
          )}
          {/* A business's named people: a person client is their own one
              contact, as on the live sheet. */}
          {client.kind === 'business' && (
            <DetailRow label="Contacts" value={<OpensWithSignal />} />
          )}
          <DetailRow label="Jobs" value={<OpensWithSignal />} />
          <DetailRow label="Notes" value={<OpensWithSignal />} />
          {xero && <DetailRow label="Xero" value={<OpensWithSignal />} />}
        </DetailRows>
      </Section>
    </>
  )
}

/**
 * A client opened with the line down that the phone's client list doesn't
 * have: said in the sheet's place, rather than a placeholder waiting for
 * good. The live sheet takes its place once PestM8 answers.
 */
export function NotKeptClient() {
  return (
    <div className="px-4 py-10">
      <Drawer.Title className="text-sheet-title text-ink">Client</Drawer.Title>
      <p className="mt-1 text-body text-ink-2">{NOT_KEPT_CLIENT}</p>
    </div>
  )
}

/** What isn't kept on the phone, in a value's place. */
function OpensWithSignal() {
  return <span className="font-normal text-muted">{OPENS_WITH_SIGNAL}</span>
}

/**
 * Who to ask for at a business client's site, as the live sheet's
 * properties say it (`siteContactOf`): nothing for a person client.
 */
function KeptSiteContact({
  clientKind,
  site,
}: {
  clientKind: DirectoryClient['kind']
  site: DirectorySite
}) {
  const contact = siteContactOf({
    clientKind,
    siteContactName: site.siteContactName,
    siteContactPhone: site.siteContactPhone,
  })
  if (!contact) return null
  return (
    <div className="mt-3 border-t border-hairline-2 pt-3">
      <h4 className="section-label mb-1">Site contact</h4>
      {contact.name && <p className="text-body text-ink">{contact.name}</p>}
      {contact.phone && (
        <>
          <p className="text-caption text-muted">{contact.phone}</p>
          <div className="mt-2">
            {/* Named after the site when nobody is, so two sites' buttons
                are not both "Call site contact". */}
            <ContactButtons
              name={contact.name ?? `site contact at ${site.addressLine}`}
              phone={contact.phone}
              show={['call', 'text']}
            />
          </div>
        </>
      )}
    </div>
  )
}

/** A section of the sheet, as the live sheet draws one. */
function Section({
  label,
  children,
  card = false,
}: {
  label: string
  children: ReactNode
  /** In a card of its own: rows that each pad themselves (`DetailRows`). */
  card?: boolean
}) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">{label}</h3>
      {card ? (
        <div className="overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
          {children}
        </div>
      ) : (
        children
      )}
    </section>
  )
}
