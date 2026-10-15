import { convexQuery } from '@convex-dev/react-query'
import { getFunctionName } from 'convex/server'
import type { FunctionReturnType } from 'convex/server'
import { api } from '../../convex/_generated/api'
import type { QueryClient } from '@tanstack/react-query'
import type { Id } from '../../convex/_generated/dataModel'
import type { LibraryFilter } from '#/components/notes/NoteList'
import type { Segment } from '#/components/reports/ReportsLibrary'
import type { MatchFilter } from '#/components/xero/xeroCopy'

type B = Id<'businesses'>

/**
 * The queries a page needs, named once so a route's loader and the page itself
 * ask for exactly the same thing.
 *
 * A page that reads its data with `useSuspenseQuery` only asks for it once it
 * renders, and the next read only once the one before it has answered — which
 * is how a cold tab cost two and three round trips of ~430 ms each. A loader
 * asks for all of them together, before the page mounts, and `defaultPreload:
 * 'intent'` runs it when a link is touched or hovered rather than when it is
 * tapped. The page then finds its answers in the cache.
 *
 * The keys have to match to the byte, or the loader warms one entry and the
 * page waits on another — hence one definition for both. Loaders are not code
 * split (they run before the route's chunk loads), so this module must not
 * import anything heavy: type-only imports from components are fine, values
 * are not.
 */
/**
 * The start of the join notices' fortnight, rounded down to a UTC day: a
 * query does not read the clock, so the caller says when "lately" began, and
 * rounding it lets a page's loader and its render ask the same question —
 * one cache entry — all day.
 */
function joinWindowStart(): number {
  const day = 24 * 60 * 60 * 1000
  return Math.floor(Date.now() / day) * day - 14 * day
}

export const rq = {
  roster: (businessId: B) =>
    convexQuery(api.memberships.listForBusiness, { businessId }),
  week: (businessId: B, startKey: string) =>
    convexQuery(api.jobs.listWeek, { businessId, startKey }),
  day: (businessId: B, dayKey: string) =>
    convexQuery(api.jobs.listDay, { businessId, dayKey }),
  month: (businessId: B, monthKey: string) =>
    convexQuery(api.jobs.listMonth, { businessId, monthKey }),
  monthTeam: (businessId: B, monthKey: string) =>
    convexQuery(api.jobs.monthTeamLoad, { businessId, monthKey }),
  jobs: (businessId: B) => convexQuery(api.jobs.list, { businessId }),
  recurringJobs: (businessId: B) =>
    convexQuery(api.jobs.listRecurring, { businessId }),
  recurringServices: (businessId: B, startOfToday: number) =>
    convexQuery(api.recurrences.services, { businessId, startOfToday }),
  clients: (businessId: B) => convexQuery(api.clients.list, { businessId }),
  properties: (businessId: B) =>
    convexQuery(api.properties.list, { businessId }),
  /** Every client and site in slim rows: the pickers, the import's "already
   * here", and the Clients page's search, A–Z and filters (`clients.ts`). */
  directory: (businessId: B) =>
    convexQuery(api.clients.directory, { businessId }),
  /** The Clients header and filters for the whole book, counted on the
   * server. */
  clientOverview: (businessId: B) =>
    convexQuery(api.clients.overview, { businessId }),
  /** The bounded Job tab list — one person's or one team's work, or an
   * older backend's whole list. `status` only when one is chosen, so the
   * unfiltered key stays the one an older app warmed. */
  jobsList: (businessId: B, status?: JobListStatus) =>
    convexQuery(
      api.jobs.list,
      status ? { businessId, status } : { businessId },
    ),
  /** The paged Job tab's caption: how many jobs, of one status or all. */
  jobCounts: (businessId: B, status?: JobListStatus) =>
    convexQuery(
      api.jobs.listCounts,
      status ? { businessId, status } : { businessId },
    ),
  /** The Recurring Job view's header without its cards. */
  recurringSummary: (businessId: B, startOfToday: number) =>
    convexQuery(api.jobs.recurringSummary, { businessId, startOfToday }),
  reportCounts: (businessId: B) =>
    convexQuery(api.reports.counts, { businessId }),
  staleDrafts: (businessId: B) =>
    convexQuery(api.reports.staleDrafts, { businessId }),
  notesPinned: (businessId: B) =>
    convexQuery(api.notes.listPinned, { businessId }),
  notesMentions: (businessId: B) =>
    convexQuery(api.notes.listMentions, { businessId }),
  summary: (businessId: B) =>
    convexQuery(api.dashboard.summary, { businessId }),
  analytics: (businessId: B) =>
    convexQuery(api.analytics.overview, { businessId }),
  currentUser: () => convexQuery(api.auth.getCurrentUser, {}),
  /** A new business's set-up guide — the owner's only (`setupGuide.ts`). */
  setupGuide: (businessId: B) =>
    convexQuery(api.setupGuide.progress, { businessId, withClients: true }),
  /** Who joined lately, for the owner's schedule (`teamJoins.ts`). */
  teamJoins: (businessId: B) =>
    convexQuery(api.teamJoins.recent, {
      businessId,
      since: joinWindowStart(),
    }),
  access: (businessId: B) => convexQuery(api.access.me, { businessId }),
  team: (businessId: B) => convexQuery(api.team.roster, { businessId }),
  invitations: (businessId: B) =>
    convexQuery(api.invitations.listForBusiness, { businessId }),
  products: (businessId: B) => convexQuery(api.products.list, { businessId }),
  /** The accounts this person may work in, for the Settings hub — contractors
   * and granted subcontractors. The owner switches from the view menu. */
  switchTargets: (businessId: B) =>
    convexQuery(api.accountSwitches.targets, { businessId }),
  /** One person's licences, with their files: their own on Settings →
   * Licences and the hub, or a member's the owner opens from Team. Never in
   * the server's HTML (`keptOutOfHtml`), so a loader warms it only through
   * `browserOnly`. */
  memberLicences: (businessId: B, membershipId: Id<'memberships'>) =>
    convexQuery(api.memberLicences.list, { businessId, membershipId }),
  /** How the business prints and sends reports — business.manage only. */
  reportSettings: (businessId: B) =>
    convexQuery(api.businesses.reportSettings, { businessId }),
  /** The answer lists the forms offer, as an owner edits them —
   * templates.manage only. */
  answerLists: (businessId: B) =>
    convexQuery(api.optionSets.editable, { businessId }),
  /** The business's job types, for New Job, the job sheet and reports. Anyone. */
  jobTypes: (businessId: B) => convexQuery(api.jobTypes.list, { businessId }),
  /** The job types as the owner edits them, with their counts — owner only. */
  jobTypesManage: (businessId: B) =>
    convexQuery(api.jobTypes.manage, { businessId }),
  /** Xero, as this person may see it: whether the deployment is set up for
   * it, the business's connection (owner only) and their own (`xero.ts`).
   * Anyone may ask; it answers with what is theirs to see. */
  xeroStatus: (businessId: B) => convexQuery(api.xero.status, { businessId }),
  /** One member's own Xero, read-only, for the owner's Team page. */
  xeroMemberStatus: (businessId: B, membershipId: Id<'memberships'>) =>
    convexQuery(api.xero.memberStatus, { businessId, membershipId }),
  /** Where one client stands in each Xero this person holds, for the client
   * sheet's Details (`xeroSync.clientLines`): none where Xero isn't set up,
   * or nothing is connected. Anyone who can see the client may ask. */
  xeroClientLines: (businessId: B, clientId: Id<'clients'>) =>
    convexQuery(api.xeroSync.clientLines, { businessId, clientId }),
  /** How many of an import's clients have reached Xero, for its Undo
   * confirm (`xeroSync.importNote`); skipped while no import is asked
   * about. */
  xeroImportNote: (businessId: B, importId: Id<'clientImports'> | null) =>
    importId === null
      ? convexQuery(api.xeroSync.importNote, 'skip')
      : convexQuery(api.xeroSync.importNote, { businessId, importId }),
}

/** How many rows the paginated libraries ask for first. */
export const REPORTS_PAGE = 25
export const NOTES_PAGE = 30
/** 24 fills the Job tab's one, two and three columns evenly. */
export const JOBS_PAGE = 24
export const CLIENTS_PAGE = 30

/**
 * The first page of a library, as a plain query.
 *
 * `usePaginatedQuery` mints a fresh pagination id on every mount and drops its
 * subscription on unmount, so nothing it fetches is ever reused: coming back
 * to Reports or Notes waited on the first page again every time. Asked for
 * this way the same rows land in the query cache, where a loader can warm them
 * and a second visit finds them already there.
 *
 * The paginator still fetches its own copy in the background — it is what
 * grows as you scroll — so this buys the wait, not the query: a visit runs
 * the first page twice on the server, and each folder or segment visited
 * leaves one plain subscription live for the cache's lifetime. At 25-30 rows
 * that is a trade worth making; if it ever stops being one, render page one
 * from this copy and mount the paginator only when more is asked for.
 */
export const reportsFirstPage = (businessId: B, filter: Segment) =>
  convexQuery(api.reports.list, {
    businessId,
    filter,
    paginationOpts: { numItems: REPORTS_PAGE, cursor: null },
  })

/** Clients on a page of Xero's match review (`xeroMatch.reviewPage`). A
 * hundred cards is more than a screen, and cheap. */
export const MATCH_PAGE = 100

/** The first page of one of the match review's lists, warmed by the match
 * page's loader and read until its paginator catches up — as the Reports
 * library does (above). */
export const matchFirstPage = (
  businessId: B,
  connectionId: Id<'xeroConnections'>,
  filter: MatchFilter,
) =>
  convexQuery(api.xeroMatch.reviewPage, {
    businessId,
    connectionId,
    filter,
    paginationOpts: { numItems: MATCH_PAGE, cursor: null },
  })

/** How long the match page's loader holds the navigation, at most. */
const MATCH_LOADER_WAIT_MS = 2000

const MATCH_FILTERS: ReadonlyArray<MatchFilter> = [
  'review',
  'matched',
  'new',
  'separate',
]

/**
 * The match page's loader (Settings → Xero → Match your clients, and My
 * Xero's): Xero's status, then — once it says which connection is this
 * person's, and that its match is in — the first page of the list being
 * opened. Never waited on past MATCH_LOADER_WAIT_MS, like the Xero page's:
 * with no signal a Convex query never answers, and the page has its own
 * placeholders.
 */
export function warmMatch(
  queryClient: QueryClient,
  businessId: B,
  kind: 'business' | 'member',
  filter: string | undefined,
): Promise<void> {
  const status = rq.xeroStatus(businessId)
  return settleWithin(
    MATCH_LOADER_WAIT_MS,
    (async () => {
      await warm(queryClient, status)
      const data = queryClient.getQueryData<
        FunctionReturnType<typeof api.xero.status>
      >(status.queryKey)
      // Only what the page will show: a member switched into someone else's
      // account sees "Switch back", and the server would refuse the list.
      const view =
        kind === 'business'
          ? data?.business
          : data?.switched
            ? null
            : data?.mine
      if (!view || view.match?.state !== 'ready') return
      const list = MATCH_FILTERS.find((each) => each === filter) ?? 'review'
      await warm(
        queryClient,
        matchFirstPage(businessId, view.connectionId, list),
      )
    })(),
  )
}

/** Mentions are their own list, not a page of the notes one. */
export type NotesPageFilter = Exclude<LibraryFilter, 'mentions'>

export const notesFirstPage = (businessId: B, filter: NotesPageFilter) =>
  convexQuery(api.notes.list, {
    businessId,
    filter,
    paginationOpts: { numItems: NOTES_PAGE, cursor: null },
  })

/** The statuses the Job tab filters by (`settableJobStatus`). */
export type JobListStatus =
  'pending' | 'booked' | 'completed' | 'invoiced' | 'cancelled'

/**
 * The paged Job tab's arguments, built once so the paginator and the warmed
 * first page ask for the same thing: `status` only when one is chosen.
 */
export const jobsPageArgs = (businessId: B, status?: JobListStatus) =>
  status ? { businessId, status } : { businessId }

export const jobsFirstPage = (businessId: B, status?: JobListStatus) =>
  convexQuery(api.jobs.listPage, {
    ...jobsPageArgs(businessId, status),
    paginationOpts: { numItems: JOBS_PAGE, cursor: null },
  })

export const clientsFirstPage = (businessId: B) =>
  convexQuery(api.clients.page, {
    businessId,
    paginationOpts: { numItems: CLIENTS_PAGE, cursor: null },
  })

/**
 * What `convexQuery()` hands back. react-query types `prefetchQuery` against
 * one query's exact data type, which a list of different queries cannot
 * satisfy, so the call below is made through this shape instead. Nothing here
 * reads the data — it only warms the cache — so the data type is not needed.
 */
type Warmable = { queryKey: ReadonlyArray<unknown> }

/**
 * The queries whose answers must never be written into a page's HTML: a
 * person's licences, with their files' storage URLs.
 *
 * Whatever a query holds when the server renders goes into the HTML
 * (router.tsx dehydrates the query cache), and the service worker keeps that
 * HTML for pages opened with no signal (`src/sw.ts`, the 'pages' cache). A
 * licence list in it would come back from there days later looking like a
 * live answer: shown as current when it is not, and — worse — taken as the
 * list to bring the phone's kept copy into line with, which forgets every
 * file added since (`syncKeptWallet`). And a storage URL is a permanent
 * capability to a card with a date of birth on it, which has no business in
 * a cache keyed by address and outliving the answer that handed it out.
 *
 * So these load in the browser, over the Convex socket, every time: the
 * loaders warm them through `browserOnly`, and router.tsx leaves them out of
 * the HTML even if something on the server did fetch one.
 */
const KEPT_OUT_OF_HTML: ReadonlySet<string> = new Set([
  getFunctionName(api.memberLicences.list),
])

/** Whether a query's answer must stay out of the HTML (see above). */
export function keptOutOfHtml(queryKey: ReadonlyArray<unknown>): boolean {
  return (
    queryKey[0] === 'convexQuery' &&
    typeof queryKey[1] === 'string' &&
    KEPT_OUT_OF_HTML.has(queryKey[1])
  )
}

/**
 * `queries` in the browser, and nothing on the server — for a loader to warm
 * a query kept out of the HTML (`keptOutOfHtml`). Warmed on the server it
 * would be fetched for an answer the page never receives, holding up the
 * render for nothing; and the server would render the list while the browser,
 * without it, rendered the placeholder — a hydration mismatch.
 */
export function browserOnly(...queries: Array<Warmable>): Array<Warmable> {
  return typeof window === 'undefined' ? [] : queries
}

/**
 * Warms every query in one go, and never rejects: a page's own read is what
 * reports a failure, exactly as it did before there were loaders.
 *
 * An entry that ends up in error with no data has to be removed, or the page
 * inherits it: `useSuspenseQuery` throws a cached error without retrying, and
 * a Convex push cannot heal an entry that has no data to update. One flaky
 * preload would otherwise leave an error screen behind for as long as the
 * entry lives.
 */
export async function warm(
  queryClient: QueryClient,
  ...queries: Array<Warmable>
): Promise<void> {
  const prefetch = queryClient.prefetchQuery.bind(queryClient)
  await Promise.all(
    // No retries: a loader blocks the navigation, and react-query's default
    // of three with backoff would sit on a permanent refusal (NO_ACCESS, say)
    // for some seven seconds before the page could report it. One attempt
    // here, and the page's own read decides what to do about it.
    queries.map((query) => prefetch({ ...query, retry: false })),
  )

  for (const { queryKey } of queries) {
    const state = queryClient.getQueryState(queryKey)
    if (state?.status !== 'error' || state.data !== undefined) continue
    // Not while something is watching it: a preload of the page you are
    // already on would pull the entry out from under its own observers, which
    // refetch as a result. Those have a component to report to anyway.
    const watched = queryClient
      .getQueryCache()
      .find({ queryKey, exact: true })
      ?.getObserversCount()
    if (!watched) queryClient.removeQueries({ queryKey, exact: true })
  }
}

/**
 * `work`, or nothing once `ms` has passed — for a loader that must not hold
 * the page hostage to a query. `warm` resolves only when its queries do, and
 * with no signal a Convex query never does, so a loader that simply awaited
 * it left the navigation on its pending screen for as long as the phone was
 * out of range. A page that has an answer for late data (a kept copy, its own
 * placeholder) warms through this instead.
 */
export function settleWithin(ms: number, work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** A search param as the loader sees it, before the route has validated it. */
export function searchParam(
  location: { search: unknown },
  key: string,
): string | undefined {
  const value = (location.search as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' ? value : undefined
}
