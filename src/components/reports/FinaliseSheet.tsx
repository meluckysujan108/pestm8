import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import {
  Check,
  CircleAlert,
  Clock,
  FileText,
  Lock,
  PenLine,
  Send,
  TriangleAlert,
} from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { LoadFailed } from '#/components/primitives/EmptyState'
import { RowPending } from '#/components/shell/Pending'
import { sectionsOf } from '#/lib/reportTemplates'
import { visibleSections } from '#/lib/reportTemplates/visibility'
import { reportSummary } from '#/lib/reportTemplates/summary'
import type { PresentContext } from '#/lib/reportTemplates/present'
import type { FieldDef, ReportTemplate } from '#/lib/reportTemplates'
import {
  PRIMARY_BUTTON,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'
import { formatTime } from '#/lib/format'
import { deviceTimezone } from '#/lib/useBusinessTimezone'
import { FormAlert } from '#/components/forms/FormAlert'
import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { clientToggleOf, lockEmail, lockEmailSentences } from './lockEmail'
import { TickBox } from './TickBox'
import type { Sentence, SendingKnown } from './lockEmail'

/**
 * The last screen before a document becomes a record.
 *
 * Finalising is irreversible by design — a compliance record that can be
 * edited after it is signed and sent is worth nothing — and the button for it
 * sits on the same bar as Save, one stray tap from a locked report nobody can
 * correct. So this says what is about to be locked, in the form's own words:
 * what the report claims, who signed it, how much evidence it carries — and
 * who it is about to be emailed to, since locking is what sends it.
 *
 * Deliberately not a hold-to-confirm gesture. Long presses misfire through
 * gloves and in the rain, and a sheet that tells you what is about to happen
 * guards better than one that only asks whether you are sure.
 */
export function FinaliseSheet({
  businessId,
  reportId,
  open,
  onClose,
  onConfirm,
  pending,
  template,
  data,
  context,
  signedSlots,
  photoCount,
  onAnswer,
  onPreview,
  previewTrouble,
}: {
  businessId: Id<'businesses'>
  reportId: Id<'reports'>
  open: boolean
  onClose: () => void
  onConfirm: () => void
  pending: boolean
  template: ReportTemplate
  data: Record<string, unknown>
  context?: PresentContext | null
  /** Signature slots this report actually holds an image for. */
  signedSlots: Array<string>
  photoCount: number
  /** Answers a question from here — the finish time, which is known now. */
  onAnswer: (key: string, value: unknown) => void
  /**
   * Opens a watermarked PDF of the draft in the app's viewer. The page closes
   * this sheet while the preview is up and puts it back after, so the viewer
   * shows its own progress and nothing here waits on the render.
   */
  onPreview?: () => void
  /** Why the last preview could not be drawn, in plain words. */
  previewTrouble?: string | null
}) {
  const fields = visibleSections(sectionsOf(template), data).flatMap(
    (section) => section.fields,
  )
  // Asked here rather than inside the sheet's body, which only mounts while
  // it is open: this component is rendered all the while the form is being
  // filled, so the answer is waiting by the time anyone opens the sheet.
  const known = useQuery(
    convexQuery(api.deliveries.known, { businessId, reportId }),
  )
  const summary = reportSummary(template, data, context)
  const signatures = fields.filter(
    (field): field is Extract<FieldDef, { kind: 'signature' }> =>
      field.kind === 'signature',
  )
  const finish = fields.find((field) => field.semantic === 'finishTime')
  const finishAnswered = finish ? isAnswered(data[finish.key]) : true
  const asksForPhotos = fields.some(
    (field) =>
      field.kind === 'gallery' ||
      field.kind === 'photos' ||
      field.kind === 'cover',
  )

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ready to lock"
      description="A locked report can’t be edited. Corrections go out as a new report."
      footer={
        <>
          {/* Read it before you lock it. Everything above is a summary; this
              is the document itself, stamped DRAFT, and opened in the app —
              view only, with nothing to share or save, so no copy of a
              document that is not finished can leave the phone. */}
          {onPreview && previewTrouble && (
            <FormAlert className="mb-2">{previewTrouble}</FormAlert>
          )}
          {onPreview && (
            <button
              type="button"
              onClick={onPreview}
              className={`${SECONDARY_BUTTON_COMPACT} mb-2 flex w-full items-center justify-center gap-2`}
            >
              <FileText size={15} strokeWidth={2} />
              Preview the document
            </button>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className={`${PRIMARY_BUTTON} flex w-full items-center justify-center gap-2`}
          >
            <Lock size={17} strokeWidth={2} />
            {pending ? 'Locking…' : 'Finalise & lock'}
          </button>
        </>
      }
    >
      {summary.length > 0 && (
        <>
          <h3 className="section-label">In this report</h3>
          <dl className="mt-1.5 overflow-hidden rounded-xl border border-hairline bg-surface">
            {summary.map((line) => (
              <div
                key={line.key}
                className="flex justify-between gap-4 border-t border-hairline px-3.5 py-2.5 first:border-t-0"
              >
                <dt className="shrink-0 text-caption text-muted">
                  {line.label}
                </dt>
                <dd
                  className={`text-right text-body ${line.tone === 'warn' ? 'text-amber-ink' : 'text-ink'}`}
                >
                  {line.text}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}

      {/* The one answer that is only knowable at this moment. Never filled
          from the start time plus a duration: a fabricated finish time on a
          signed record is a false statement about where someone was. */}
      {finish && !finishAnswered && (
        <button
          type="button"
          onClick={() => onAnswer(finish.key, nowAsTime())}
          className="mt-3 flex w-full items-center gap-2 rounded-xl border border-dashed border-hairline px-3.5 py-2.5 text-left text-body text-ink"
        >
          <Clock size={15} strokeWidth={2} className="text-muted" />
          {finish.label.replace(/:$/, '')} — set to {readableNow()}
        </button>
      )}

      <ul className="mt-3 flex flex-col gap-2">
        {signatures.map((field) => {
          const signed = signedSlots.includes(field.slot)
          // The client's pad is never needed to lock
          // (`withOptionalClientSignatures`): said as the fact it is, not as
          // a warning, which read as something still to be done.
          if (field.role === 'client' && !signed) {
            return (
              <Row key={field.key} ok={false} optional>
                {padName(field)} — not signed (optional)
              </Row>
            )
          }
          return (
            // An unsigned technician's pad is a warning, not a refusal: a
            // business can stop insisting on one, and a pad it still insists
            // on never reaches this sheet unsigned.
            <Row key={field.key} ok={signed} warn={!signed}>
              {padName(field)} — {signed ? 'signed' : 'not signed'}
            </Row>
          )
        })}
        {/* Only where the form asks for evidence. A count of nothing on a form
            that never wanted a photo is a line that reads like a shortfall. */}
        {asksForPhotos && (
          <Row ok={photoCount > 0}>
            {photoCount === 0
              ? 'No photos'
              : photoCount === 1
                ? '1 photo'
                : `${photoCount} photos`}
          </Row>
        )}
      </ul>

      <LockEmailNote
        reportId={reportId}
        template={template}
        data={data}
        clientEmail={context?.client?.email}
        known={known.data}
        failed={known.isError}
        onRetry={() => void known.refetch()}
        onAnswer={onAnswer}
      />
    </Sheet>
  )
}

/**
 * What a signature pad is called here. The forms label the client's pad
 * plain "Signature" beside "Technician's Signature", which on this sheet —
 * out of the form's layout — reads as the technician's own.
 */
function padName(field: Extract<FieldDef, { kind: 'signature' }>): string {
  const label = field.label.replace(/:$/, '')
  return field.role === 'client' && !/client/i.test(label)
    ? 'Client’s signature'
    : label
}

function Row({
  ok,
  warn,
  optional,
  children,
}: {
  ok: boolean
  warn?: boolean
  /** Not done, and not needed: neither a tick nor a warning. */
  optional?: boolean
  children: React.ReactNode
}) {
  return (
    <li
      className={`flex items-center gap-2 text-body ${warn ? 'text-amber-ink' : 'text-ink-2'}`}
    >
      {warn ? (
        <TriangleAlert size={15} strokeWidth={2} className="shrink-0" />
      ) : optional ? (
        <PenLine size={15} strokeWidth={2} className="shrink-0 text-muted" />
      ) : (
        <Check
          size={15}
          strokeWidth={2.2}
          className={`shrink-0 ${ok ? 'text-green' : 'text-muted'}`}
        />
      )}
      {children}
    </li>
  )
}

function isAnswered(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

/** `14:05` — the shape a `time` field stores, in the phone's own timezone. */
function nowAsTime(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

/** `2:05pm` — what `nowAsTime` stored, said the way the app says a time. */
function readableNow(): string {
  return formatTime(Date.now(), deviceTimezone())
}

/**
 * Who locking emails this report to, said before the button that does it.
 *
 * Read from the same rule `reports.finalise` applies (`lockEmail`), with the
 * server's own answer about what is on file, where the business's copy goes
 * and whether this deployment can send at all. The client's copy can be
 * switched off here: it is the form's own send-copy question, and the last
 * screen before the email goes is where "not yet" gets decided.
 */
function LockEmailNote({
  reportId,
  template,
  data,
  clientEmail,
  known,
  failed,
  onRetry,
  onAnswer,
}: {
  reportId: Id<'reports'>
  template: ReportTemplate
  data: Record<string, unknown>
  clientEmail?: string
  /** `deliveries.known`, or undefined while it is being asked. */
  known?: SendingKnown & { emailReady: boolean; largeForEmail?: boolean }
  failed: boolean
  onRetry: () => void
  onAnswer: (key: string, value: unknown) => void
}) {
  // From the form alone, so it is there at once — on weak signal too, which
  // is exactly when "not yet" is worth being able to say.
  const toggle = clientToggleOf(template, data, clientEmail)
  const plan = known ? lockEmail(template, data, clientEmail, known) : null

  return (
    <section className="mt-4" aria-labelledby={`lock-email-${reportId}`}>
      <h3 id={`lock-email-${reportId}`} className="section-label">
        Email
      </h3>
      {toggle && (
        <button
          type="button"
          aria-pressed={toggle.on}
          onClick={() => onAnswer(toggle.key, !toggle.on)}
          className={`mt-1.5 flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
            toggle.on
              ? 'border-ink/15 bg-surface'
              : 'border-hairline bg-surface-2'
          }`}
        >
          <TickBox on={toggle.on} />
          <span className="min-w-0 flex-1">
            <span className="block text-body text-ink">Email the client</span>
            <span className="block truncate text-caption text-ink-2">
              {toggle.address}
            </span>
          </span>
          {toggle.on && toggle.problem !== null && (
            <span className="flex shrink-0 items-center gap-1 text-caption text-red-ink">
              <CircleAlert size={13} strokeWidth={2} />
              Can’t be delivered
            </span>
          )}
        </button>
      )}
      {plan && known ? (
        <div className="mt-1.5 flex gap-2 rounded-xl border border-hairline bg-surface-2 px-3 py-2.5">
          <Send
            size={15}
            strokeWidth={2}
            aria-hidden
            className="mt-0.5 shrink-0 text-ink-2"
          />
          {/* Polite, so switching the client's copy off is heard as well as
              seen: the sentence is the answer to the tap. */}
          <p aria-live="polite" className="text-caption text-ink-2">
            {/* Only an explicit "no" means email is off. A backend older than
                this screen does not say, and reading that silence as "won't
                be emailed" on a deployment that does email is the very
                instruction that sent clients a second copy. */}
            {lockEmailSentences(plan, known.emailReady !== false, {
              clientToggle: toggle,
              clientHasEmail: Boolean(clientEmail?.trim()),
              largeForEmail: known.largeForEmail === true,
            }).map((sentence, index) => (
              <SentenceText key={index} sentence={sentence} lead={index > 0} />
            ))}
          </p>
        </div>
      ) : failed ? (
        <LoadFailed
          what="who this goes to"
          onRetry={onRetry}
          className="mt-1.5"
        />
      ) : (
        <RowPending announce={false} className="mt-1.5 py-1" />
      )}
    </section>
  )
}

/** One sentence of `lockEmailSentences`, its addresses set in ink. */
function SentenceText({
  sentence,
  lead,
}: {
  sentence: Sentence
  /** Not the first sentence, so it follows a space. */
  lead: boolean
}) {
  return (
    <>
      {lead ? ' ' : ''}
      {sentence.map((part, index) =>
        typeof part === 'string' ? (
          part
        ) : (
          <span key={index} className="break-words font-semibold text-ink">
            {part.address}
          </span>
        ),
      )}
    </>
  )
}
