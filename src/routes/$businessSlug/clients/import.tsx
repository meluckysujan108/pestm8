import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useConvex } from 'convex/react'
import { api } from '../../../../convex/_generated/api'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { useLatest } from '#/components/forms/SaveWarnings'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { BackLink } from '#/components/settings/ui'
import { ChooseStep } from '#/components/clients/import/ChooseStep'
import { DoneStep } from '#/components/clients/import/DoneStep'
import { ImportingStep } from '#/components/clients/import/ImportingStep'
import { MatchStep } from '#/components/clients/import/MatchStep'
import { RecheckNote, ReviewStep } from '#/components/clients/import/ReviewStep'
import { recentImports } from '#/components/clients/import/queries'
import {
  newlySent,
  recheckReview,
  undoneIds,
  undoneSince,
} from '#/components/clients/import/recheck'
import {
  ImportBody,
  Stepper,
  focusStepHeading,
} from '#/components/clients/import/ui'
import {
  UndoHold,
  undoHolding,
  useUndoClock,
} from '#/components/clients/import/undo'
import {
  refusedBeforeStart,
  useImportRun,
} from '#/components/clients/import/useImportRun'
import {
  buildReview,
  checkAcrossClients,
  recheckClient,
} from '#/lib/clientImport/build'
import { checkClientOffline, runOfflineChecks } from '#/lib/clientImport/checks'
import { autoMap, detectSource } from '#/lib/clientImport/columns'
import {
  importable,
  indexExisting,
  toImportClient,
} from '#/lib/clientImport/convert'
import { ImportFileError, readImportFile } from '#/lib/clientImport/read'
import { useActing, useCan } from '#/lib/access'
import { rq, warm } from '#/lib/routeQueries'
import type { Access } from '#/lib/access'
import type {
  ColumnMapping,
  ExistingIndex,
  ImportSheet,
  ReviewClient,
  ReviewIssue,
  SourceApp,
} from '#/lib/clientImport/types'

/**
 * "Bring your clients across": a client list from another app or a
 * spreadsheet, read in the browser, matched, reviewed, and only then sent.
 *
 *   choose ─▶ match ─▶ review ─▶ importing ─▶ done
 *
 * Everything up to Import happens on this page and nowhere else — the file
 * never leaves the browser, and nothing is written — so Back is always free
 * and a wrong guess costs nothing. The server re-checks every client it is
 * sent (convex/clientImports.ts), with the same rules the review applied.
 */
export const Route = createFileRoute('/$businessSlug/clients/import')({
  // Only the recent imports, for the first step. What "already here" is
  // read from — the whole client and site lists — is read once, at
  // Continue (`toReview`), not kept live: see there. Only for someone who
  // may import: anyone else is shown why not.
  loader: ({ context: { queryClient, business } }) => {
    const access = queryClient.getQueryData<Access>(
      rq.access(business._id).queryKey,
    )
    if (access?.caps['clients.manage'] !== true) return
    return warm(queryClient, recentImports(business._id))
  },
  component: ImportPage,
})

function ImportPage() {
  const { business } = Route.useRouteContext()
  // The server refuses an import to anyone without this — subcontractors,
  // and an owner working inside someone else's account — so they are told
  // here rather than after choosing a file.
  const canImport = useCan('clients.manage')
  const { isSwitched } = useActing()

  return (
    <>
      <PageHeader
        businessId={business._id}
        businessSlug={business.slug}
        title="Import clients"
        back={
          <BackLink
            to="/$businessSlug/clients"
            params={{ businessSlug: business.slug }}
          >
            Clients
          </BackLink>
        }
      />
      {canImport ? (
        <ImportFlow />
      ) : (
        <ImportBody>
          <EmptyState
            title="Importing is for the owner and contractors"
            body={
              isSwitched
                ? 'Switch back to your own account to import clients.'
                : 'Ask the business owner to bring your clients across.'
            }
          />
        </ImportBody>
      )}
    </>
  )
}

type Step = 'choose' | 'match' | 'review'

const scrollToTop = () => window.scrollTo({ top: 0 })

/** What a review knows of PestM8 before it has asked: nothing. */
const NOTHING_YET: ExistingIndex = {
  clientsByName: new Map(),
  siteKeys: new Set(),
}

const sameHeaders = (a: Array<string>, b: Array<string>) =>
  a.length === b.length && a.every((header, i) => header === b[i])

function ImportFlow() {
  const { business } = Route.useRouteContext()
  const businessId = business._id
  const businessState = business.state
  const convex = useConvex()

  const [step, setStep] = useState<Step>('choose')
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [file, setFile] = useState<{
    sheet: ImportSheet
    source: SourceApp | null
  } | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping>([])
  const [review, setReview] = useState<Array<ReviewClient> | null>(null)
  const [progress, setProgress] = useState<{
    done: number
    total: number
  } | null>(null)
  const [checkFailed, setCheckFailed] = useState(false)
  const [continueError, setContinueError] = useState<unknown>(null)
  const [edited, setEdited] = useState(false)
  const [askBack, setAskBack] = useState(false)
  const run = useImportRun(businessId)

  // An undo not yet done holds a new file back — one that has stopped
  // part-way too, until it is carried on: until it reaches them, the
  // clients it is taking back read as already here, so the same file again
  // would skip them — and the undo would then take them away too. Choose,
  // the window drop, Continue and Import all wait (`undoUnderway`). Whether
  // one has stopped is the page's one clock's to say (`useUndoClock`),
  // handed to every piece that shows an undo.
  const { data: imports } = useQuery(recentImports(businessId))
  const clock = useUndoClock(imports)
  const holding = undoHolding(imports, clock)
  const undoing = holding !== null

  /** Which review build is current: going back mid-check, and on again,
   * must not let the first check's answer land on the second review. */
  const build = useRef(0)
  /** Each client's latest change, so a slow address check about an older
   * version of it never overwrites a newer one. */
  const versions = useRef(new Map<string, number>())
  /**
   * What PestM8 held when Continue was pressed, with the business's state:
   * what every decision of this review is made against — the build, each
   * fix and save, and so what is sent. Read once and kept, not followed:
   * the lists are the whole directory, and every batch of an import writes
   * to them, so a live copy would be re-sent in full after each one — and
   * the server checks every client again as it writes it anyway.
   */
  const against = useRef({ businessState, existing: NOTHING_YET })
  /** The imports already undone when `against` was read (`undoneIds`): one
   * asked for since, from another screen, has made it out of date. */
  const [undoneAtRead, setUndoneAtRead] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  /** PestM8 to be read again whatever the imports say: Import was turned
   * down because an undo had begun (`refusedBeforeStart`). */
  const [recheckDue, setRecheckDue] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [recheckError, setRecheckError] = useState<unknown>(null)
  const clearRecheck = () => {
    setRecheckDue(false)
    setRechecking(false)
    setRecheckError(null)
  }

  // Import turned down at the start for an undo under way: nothing went in,
  // and the review is from before that undo. Back to it, to wait.
  const refused = refusedBeforeStart(run.state)
  const idle = run.state.status === 'idle' || refused
  const { reset: resetRun } = run
  useEffect(() => {
    if (!refused) return
    resetRun()
    setRecheckDue(true)
  }, [refused, resetRun])

  /**
   * Whether the review's picture of PestM8 (`against`) is from before an
   * undo — asked for since, from another tab or phone. Import waits: once
   * the undo is done, PestM8 is read again (`recheck`).
   */
  const stale =
    step === 'review' &&
    idle &&
    review !== null &&
    (recheckDue || undoneSince(imports, undoneAtRead))

  // Leaving is asked about mid-import — what has gone in stays, with Undo —
  // and mid-review once something has been changed, as nothing of the
  // review is kept. In the app with a dialog below; closing the tab with
  // the browser's own question. Not on the Done screen: it's all in.
  const importing = run.state.status === 'running'
  const reviewing = run.state.status === 'idle' && step === 'review' && edited
  const alwaysBlock = useCallback(() => true, [])
  const blocker = useBlocker({
    shouldBlockFn: alwaysBlock,
    enableBeforeUnload: true,
    disabled: !importing && !reviewing,
    withResolver: true,
  })

  const choose = async (chosen: File) => {
    setReading(true)
    setReadError(null)
    try {
      const sheet = await readImportFile(chosen)
      // The same columns as the file before — most often the same file,
      // chosen again after Back — keep the columns as they were matched.
      // Anything else starts from the guess.
      if (!file || !sameHeaders(file.sheet.headers, sheet.headers)) {
        setMapping(autoMap(sheet))
      }
      setFile({ sheet, source: detectSource(sheet.headers) })
      setContinueError(null)
      setStep('match')
      scrollToTop()
    } catch (error) {
      setReadError(
        error instanceof ImportFileError
          ? error.message
          : `Couldn’t read “${chosen.name}”. Save it again as CSV and choose that instead.`,
      )
    } finally {
      setReading(false)
    }
  }

  // A file let go of anywhere on the page is taken as chosen on the first
  // step, and ignored on the others — either way it's the page's, not the
  // browser's, which would open the file in place of the page and lose
  // whatever the person was doing.
  const canChoose =
    step === 'choose' && run.state.status === 'idle' && !reading && !undoing
  const latest = useLatest({
    canChoose,
    choose,
    undoing,
    imports,
    review,
    recheck: () => recheck(),
  })
  useEffect(() => {
    const files = (event: DragEvent) =>
      event.dataTransfer?.types.includes('Files') === true
    const hold = (event: DragEvent) => {
      if (files(event)) event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      if (!files(event)) return
      event.preventDefault()
      const dropped = event.dataTransfer?.files[0]
      if (dropped && latest.current.canChoose) {
        void latest.current.choose(dropped)
      }
    }
    window.addEventListener('dragover', hold)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', hold)
      window.removeEventListener('drop', drop)
    }
  }, [latest])

  const toReview = async () => {
    // Not mid-undo: what's already here is read now and kept, and mid-undo
    // it would still count what the undo is about to take away. A file read
    // while Undo was being confirmed gets as far as Match, which says why
    // Continue waits.
    if (!file || undoing) return
    const token = ++build.current
    const current = () => build.current === token
    versions.current.clear()
    setReview(null)
    setCheckFailed(false)
    setContinueError(null)
    setEdited(false)
    setProgress(null)
    clearRecheck()
    setStep('review')
    scrollToTop()

    let existing: ExistingIndex
    try {
      // Asked once, not subscribed to (see `against`): `query` lets go of
      // each list as soon as it has answered.
      const [clients, properties] = await Promise.all([
        convex.query(api.clients.list, { businessId }),
        convex.query(api.properties.list, { businessId }),
      ])
      existing = indexExisting(clients, properties)
    } catch (error) {
      if (current()) {
        setContinueError(error)
        setStep('match')
      }
      return
    }
    if (!current()) return
    // An undo asked for while the lists were on their way — from another
    // screen — makes them part-way through it: back to Match, to wait.
    if (latest.current.undoing) {
      setStep('match')
      return
    }
    against.current = { businessState, existing }
    // As the page last showed them — never newer than the lists — so an
    // undo the lists might be part-way through is one asked for since.
    setUndoneAtRead(undoneIds(latest.current.imports))

    // Synchronous and quick (about 40 ms for 2,000 rows); the address
    // tables are what take a moment, so the count is for them.
    const built = buildReview(file.sheet, mapping, against.current)
    setProgress({ done: 0, total: built.length })
    try {
      const checked = await runOfflineChecks(built, {
        businessState,
        onProgress: (done, total) => {
          if (current()) setProgress({ done, total })
        },
        stopped: () => !current(),
      })
      if (current()) setReview(checkAcrossClients(checked))
    } catch {
      // The suburb tables are loaded on demand, and a chunk that won't load
      // (an update deployed mid-review, a dropped connection) shouldn't
      // strand the review: it goes on without them, and says so.
      if (current()) {
        setReview(checkAcrossClients(built))
        setCheckFailed(true)
      }
    } finally {
      if (current()) setProgress(null)
    }
  }

  /** One client as it now stands, and the checks that need the whole list
   * run again: an address two clients share is about both of them. */
  const replace = useCallback(
    (next: ReviewClient) =>
      setReview((list) =>
        list
          ? checkAcrossClients(
              list.map((client) => (client.key === next.key ? next : client)),
            )
          : null,
      ),
    [],
  )

  /** A new version of a client: a slower answer about an older one is
   * then dropped (`versions`). */
  const bump = useCallback((key: string) => {
    const version = (versions.current.get(key) ?? 0) + 1
    versions.current.set(key, version)
    return version
  }, [])

  /** A client changed — fixed, edited or left out — as it now stands, then
   * again once its addresses have been checked. */
  const settle = useCallback(
    (next: ReviewClient, recheck = true) => {
      setEdited(true)
      const version = bump(next.key)
      replace(next)
      if (!recheck) return
      const at = against.current
      checkClientOffline(next, { businessState }).then(
        (checked) => {
          if (checked !== next && versions.current.get(next.key) === version) {
            // PestM8 read again meanwhile (`recheck`): judged against that.
            replace(
              against.current === at
                ? checked
                : recheckClient(checked, against.current),
            )
          }
        },
        // Unchecked is how it was before the edit, too: nothing to undo.
        () => undefined,
      )
    },
    [businessState, bump, replace],
  )

  /**
   * PestM8 read again once an undo run since the review was built is done
   * (`stale`), and every client judged afresh against it, as edited — then
   * the address checks for any site that was already here and now goes in.
   * Import waits for all of it. Once, as Continue reads it (see `against`).
   */
  const recheck = async () => {
    const token = build.current
    const current = () => build.current === token
    setRechecking(true)
    setRecheckError(null)
    try {
      const [clients, properties] = await Promise.all([
        convex.query(api.clients.list, { businessId }),
        convex.query(api.properties.list, { businessId }),
      ])
      if (!current()) return
      // Another undo asked for while the lists were on their way: they may
      // be part-way through it. That one is waited for too, then read again.
      if (latest.current.undoing) return
      const at = { businessState, existing: indexExisting(clients, properties) }
      // As last shown, edits and all: a tap's change is drawn before
      // anything else happens.
      const before = latest.current.review ?? []
      against.current = at
      setUndoneAtRead(undoneIds(latest.current.imports))
      setRecheckDue(false)
      setReview((list) => list && recheckReview(list, at))

      const freed = newlySent(before, at)
      if (freed.length === 0) return
      const asked = new Map(
        freed.map((client) => [client.key, bump(client.key)]),
      )
      try {
        const checked = await runOfflineChecks(freed, {
          businessState,
          stopped: () => !current(),
        })
        if (!current()) return
        // Not one changed since: that change has had its own check.
        const fresh = new Map(
          checked
            .filter((c) => versions.current.get(c.key) === asked.get(c.key))
            .map((c) => [c.key, c]),
        )
        if (fresh.size > 0) {
          setReview(
            (list) =>
              list &&
              checkAcrossClients(list.map((c) => fresh.get(c.key) ?? c)),
          )
        }
      } catch {
        // As at Continue: without the suburb tables, it goes on, and says so.
        if (current()) setCheckFailed(true)
      }
    } catch (error) {
      if (current()) setRecheckError(error)
    } finally {
      if (current()) setRechecking(false)
    }
  }
  const recheckWanted =
    stale && !undoing && !rechecking && recheckError === null
  useEffect(() => {
    if (recheckWanted) void latest.current.recheck()
  }, [recheckWanted, latest])

  const fix = useCallback(
    (client: ReviewClient, issue: ReviewIssue) => {
      if (issue.fix) {
        settle(recheckClient(issue.fix.apply(client), against.current))
      }
    },
    [settle],
  )
  const save = useCallback(
    (client: ReviewClient) => settle(recheckClient(client, against.current)),
    [settle],
  )
  const toggle = useCallback(
    (client: ReviewClient) =>
      settle({ ...client, included: !client.included }, false),
    [settle],
  )

  const backToColumns = () => {
    build.current += 1
    clearRecheck()
    setAskBack(false)
    setReview(null)
    setProgress(null)
    setStep('match')
    scrollToTop()
  }

  const startImport = () => {
    // Not while an undo runs, nor until PestM8 has been read again after
    // one: the review would skip, as already here, what the undo takes.
    if (!file || !review || undoing || stale || rechecking) return
    run.begin(review.filter(importable).map(toImportClient), {
      fileName: file.sheet.fileName,
      source: file.source,
    })
    scrollToTop()
  }

  const startAgain = () => {
    run.reset()
    build.current += 1
    clearRecheck()
    setFile(null)
    setReview(null)
    setMapping([])
    setReadError(null)
    setContinueError(null)
    setStep('choose')
    scrollToTop()
  }

  // A new step's heading takes focus: the button that had it went with the
  // step before, and focus would otherwise fall back to the top of the
  // document. Not on arrival — the page is where a visit starts.
  const showing = !idle
    ? run.state.status
    : step === 'review' && review === null
      ? 'checking'
      : step
  const shown = useRef(showing)
  useEffect(() => {
    if (shown.current === showing) return
    shown.current = showing
    focusStepHeading()
  }, [showing])

  const leaving = (
    <ConfirmDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open && blocker.status === 'blocked') blocker.reset()
      }}
      title="Leave while importing?"
      body="What has gone in so far stays in PestM8, and Recent imports has it, with Undo. The rest won’t be sent."
      confirm="Leave"
      cancel="Stay"
      onConfirm={() => {
        if (blocker.status === 'blocked') blocker.proceed()
      }}
    />
  )

  if (!idle && file && review) {
    return (
      <ImportBody>
        {run.state.status === 'done' ? (
          <DoneStep
            businessId={businessId}
            businessSlug={business.slug}
            sheet={file.sheet}
            review={review}
            results={run.state.results}
            importId={run.state.importId}
            clock={clock}
            onAnother={startAgain}
          />
        ) : (
          <ImportingStep
            state={run.state}
            wait={
              holding &&
              holding.row._id !== run.state.importId && (
                <UndoHold
                  businessId={businessId}
                  row={holding.row}
                  stopped={holding.stopped}
                  then="try again"
                />
              )
            }
            onRetry={() => void run.retry()}
            onFinish={run.finish}
          />
        )}
        {leaving}
      </ImportBody>
    )
  }

  return (
    <ImportBody>
      <Stepper current={step} />

      {step === 'choose' && (
        <ChooseStep
          businessId={businessId}
          timezone={business.timezone}
          reading={reading}
          holding={holding}
          clock={clock}
          error={readError}
          onChoose={(chosen) => void choose(chosen)}
        />
      )}

      {step === 'match' && file && (
        <MatchStep
          sheet={file.sheet}
          source={file.source}
          mapping={mapping}
          error={continueError}
          wait={
            holding && (
              <UndoHold
                businessId={businessId}
                row={holding.row}
                stopped={holding.stopped}
                then="continue"
                className="mb-3"
              />
            )
          }
          onChange={setMapping}
          onBack={() => {
            setStep('choose')
            scrollToTop()
          }}
          onContinue={() => void toReview()}
        />
      )}

      {step === 'review' && file && (
        <ReviewStep
          sheet={file.sheet}
          clients={review}
          progress={progress}
          checkFailed={checkFailed}
          businessState={businessState}
          wait={
            holding ? (
              <UndoHold
                businessId={businessId}
                row={holding.row}
                stopped={holding.stopped}
                then="import"
                className="mb-3"
              />
            ) : stale || rechecking ? (
              <RecheckNote
                error={recheckError}
                onRetry={() => setRecheckError(null)}
              />
            ) : null
          }
          onFix={fix}
          onSave={save}
          onToggle={toggle}
          onBack={() => (edited ? setAskBack(true) : backToColumns())}
          onImport={startImport}
        />
      )}

      <ConfirmDialog
        open={askBack}
        onOpenChange={setAskBack}
        title="Go back to the columns?"
        body="The review is built again from the file, so the changes you’ve made here will be lost."
        confirm="Go back"
        cancel="Stay here"
        onConfirm={backToColumns}
      />
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.status === 'blocked') blocker.reset()
        }}
        title="Leave the review?"
        body="The changes you’ve made here will be lost — nothing is saved until you press Import."
        confirm="Leave"
        cancel="Stay"
        onConfirm={() => {
          if (blocker.status === 'blocked') blocker.proceed()
        }}
      />
    </ImportBody>
  )
}
