import { useCallback, useMemo, useRef, useState } from 'react'
import { createFileRoute, useBlocker } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { PageHeader } from '#/components/shell/PageHeader'
import { EmptyState } from '#/components/primitives/EmptyState'
import { ConfirmDialog } from '#/components/settings/ConfirmDialog'
import { BackLink } from '#/components/settings/ui'
import { ChooseStep } from '#/components/clients/import/ChooseStep'
import { DoneStep } from '#/components/clients/import/DoneStep'
import { ImportingStep } from '#/components/clients/import/ImportingStep'
import { MatchStep } from '#/components/clients/import/MatchStep'
import { ReviewStep } from '#/components/clients/import/ReviewStep'
import { recentImports } from '#/components/clients/import/queries'
import { ImportBody, Stepper } from '#/components/clients/import/ui'
import { useImportRun } from '#/components/clients/import/useImportRun'
import { buildReview, recheckClient } from '#/lib/clientImport/build'
import { checkClientOffline, runOfflineChecks } from '#/lib/clientImport/checks'
import { autoMap, detectSource } from '#/lib/clientImport/columns'
import {
  importable,
  indexExisting,
  toImportClient,
} from '#/lib/clientImport/convert'
import { ImportFileError, readImportFile } from '#/lib/clientImport/read'
import { useCan } from '#/lib/access'
import { rq, warm } from '#/lib/routeQueries'
import type { Access } from '#/lib/access'
import type {
  ColumnMapping,
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
  // What "already here" is read from, together, before the page renders —
  // as the Clients page does. Only for someone who may import: anyone else
  // is shown why not, and has no use for the lists.
  loader: ({ context: { queryClient, business } }) => {
    const access = queryClient.getQueryData<Access>(
      rq.access(business._id).queryKey,
    )
    if (access?.caps['clients.manage'] !== true) return
    return warm(
      queryClient,
      rq.clients(business._id),
      rq.properties(business._id),
      recentImports(business._id),
    )
  },
  component: ImportPage,
})

function ImportPage() {
  const { business } = Route.useRouteContext()
  // The server refuses an import to anyone without this — subcontractors,
  // and an owner working inside someone else's account — so they are told
  // here rather than after choosing a file.
  const canImport = useCan('clients.manage')

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
            body="Ask the business owner to bring your clients across."
          />
        </ImportBody>
      )}
    </>
  )
}

type Step = 'choose' | 'match' | 'review'

const scrollToTop = () => window.scrollTo({ top: 0 })

function ImportFlow() {
  const { business } = Route.useRouteContext()
  const businessState = business.state
  const { data: clients } = useSuspenseQuery(rq.clients(business._id))
  const { data: properties } = useSuspenseQuery(rq.properties(business._id))
  const existing = useMemo(
    () => indexExisting(clients, properties),
    [clients, properties],
  )
  const opts = useMemo(
    () => ({ businessState, existing }),
    [businessState, existing],
  )

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
  const [edited, setEdited] = useState(false)
  const [askBack, setAskBack] = useState(false)
  const run = useImportRun(business._id)

  /** Which review build is current: going back mid-check, and on again,
   * must not let the first check's answer land on the second review. */
  const build = useRef(0)
  /** Each client's latest change, so a slow address check about an older
   * version of it never overwrites a newer one. */
  const versions = useRef(new Map<string, number>())

  // Mid-import, leaving is asked about: in the app with the dialog below,
  // and closing the tab with the browser's own question. Leaving stops the
  // import after the batch in flight; what went in stays, with Undo.
  const alwaysBlock = useCallback(() => true, [])
  const blocker = useBlocker({
    shouldBlockFn: alwaysBlock,
    enableBeforeUnload: true,
    disabled: run.state.status !== 'running',
    withResolver: true,
  })

  const choose = async (chosen: File) => {
    setReading(true)
    setReadError(null)
    try {
      const sheet = await readImportFile(chosen)
      setFile({ sheet, source: detectSource(sheet.headers) })
      setMapping(autoMap(sheet))
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

  const toReview = async () => {
    if (!file) return
    const token = ++build.current
    // Synchronous and quick (about 40 ms for 2,000 rows); the address
    // tables are what take a moment, so the count is for them.
    const built = buildReview(file.sheet, mapping, opts)
    versions.current.clear()
    setReview(null)
    setCheckFailed(false)
    setEdited(false)
    setProgress({ done: 0, total: built.length })
    setStep('review')
    scrollToTop()
    try {
      const checked = await runOfflineChecks(built, {
        businessState,
        onProgress: (done, total) => {
          if (build.current === token) setProgress({ done, total })
        },
      })
      if (build.current === token) setReview(checked)
    } catch {
      // The suburb tables are loaded on demand, and a chunk that won't load
      // (an update deployed mid-review, a dropped connection) shouldn't
      // strand the review: it goes on without them, and says so.
      if (build.current === token) {
        setReview(built)
        setCheckFailed(true)
      }
    } finally {
      if (build.current === token) setProgress(null)
    }
  }

  const replace = useCallback(
    (next: ReviewClient) =>
      setReview(
        (list) =>
          list?.map((client) => (client.key === next.key ? next : client)) ??
          null,
      ),
    [],
  )

  /** A client changed — fixed, edited or left out — as it now stands, then
   * again once its addresses have been checked. */
  const settle = useCallback(
    (next: ReviewClient, recheck = true) => {
      setEdited(true)
      const version = (versions.current.get(next.key) ?? 0) + 1
      versions.current.set(next.key, version)
      replace(next)
      if (!recheck) return
      checkClientOffline(next, { businessState }).then(
        (checked) => {
          if (checked !== next && versions.current.get(next.key) === version) {
            replace(checked)
          }
        },
        // Unchecked is how it was before the edit, too: nothing to undo.
        () => undefined,
      )
    },
    [businessState, replace],
  )

  const fix = useCallback(
    (client: ReviewClient, issue: ReviewIssue) => {
      if (issue.fix) settle(recheckClient(issue.fix.apply(client), opts))
    },
    [opts, settle],
  )
  const save = useCallback(
    (client: ReviewClient) => settle(recheckClient(client, opts)),
    [opts, settle],
  )
  const toggle = useCallback(
    (client: ReviewClient) =>
      settle({ ...client, included: !client.included }, false),
    [settle],
  )

  const backToColumns = () => {
    build.current += 1
    setAskBack(false)
    setReview(null)
    setProgress(null)
    setStep('match')
    scrollToTop()
  }

  const startImport = () => {
    if (!file || !review) return
    run.begin(review.filter(importable).map(toImportClient), {
      fileName: file.sheet.fileName,
      source: file.source,
    })
    scrollToTop()
  }

  const startAgain = () => {
    run.reset()
    build.current += 1
    setFile(null)
    setReview(null)
    setMapping([])
    setReadError(null)
    setStep('choose')
    scrollToTop()
  }

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

  if (run.state.status !== 'idle' && file && review) {
    return (
      <ImportBody>
        {run.state.status === 'done' ? (
          <DoneStep
            businessId={business._id}
            businessSlug={business.slug}
            sheet={file.sheet}
            review={review}
            results={run.state.results}
            importId={run.state.importId}
            onAnother={startAgain}
          />
        ) : (
          <ImportingStep
            state={run.state}
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
          businessId={business._id}
          timezone={business.timezone}
          reading={reading}
          error={readError}
          onChoose={(chosen) => void choose(chosen)}
        />
      )}

      {step === 'match' && file && (
        <MatchStep
          sheet={file.sheet}
          source={file.source}
          mapping={mapping}
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
    </ImportBody>
  )
}
