import { Check, Clock, FileText, Loader2, Lock, TriangleAlert } from 'lucide-react'
import { Sheet } from '#/components/primitives/Sheet'
import { sectionsOf } from '#/lib/reportTemplates'
import { visibleSections } from '#/lib/reportTemplates/visibility'
import { reportSummary } from '#/lib/reportTemplates/summary'
import type { PresentContext } from '#/lib/reportTemplates/present'
import type { FieldDef, ReportTemplate } from '#/lib/reportTemplates'

/**
 * The last screen before a document becomes a record.
 *
 * Finalising is irreversible by design — a compliance record that can be
 * edited after it is signed and sent is worth nothing — and the button for it
 * sits on the same bar as Save, one stray tap from a locked report nobody can
 * correct. So this says what is about to be locked, in the form's own words:
 * what the report claims, who signed it, how much evidence it carries and who
 * the form says should receive a copy.
 *
 * Deliberately not a hold-to-confirm gesture. Long presses misfire through
 * gloves and in the rain, and a sheet that tells you what is about to happen
 * guards better than one that only asks whether you are sure.
 */
export function FinaliseSheet({
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
  previewing,
}: {
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
  /** Opens a watermarked PDF of the draft. Absent while one is being drawn. */
  onPreview?: () => void
  previewing?: boolean
}) {
  const fields = visibleSections(sectionsOf(template), data).flatMap((section) => section.fields)
  const summary = reportSummary(template, data, context)
  const signatures = fields.filter(
    (field): field is Extract<FieldDef, { kind: 'signature' }> => field.kind === 'signature',
  )
  const finish = fields.find((field) => field.semantic === 'finishTime')
  const finishAnswered = finish ? isAnswered(data[finish.key]) : true
  const recipients = recipientsOf(fields, data, context)
  const asksForPhotos = fields.some(
    (field) => field.kind === 'gallery' || field.kind === 'photos' || field.kind === 'cover',
  )

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ready to lock"
      description="A locked report can't be edited. Corrections go out as a new report."
      footer={
        <>
          {/* Read it before you lock it. Everything above is a summary; this
              is the document itself, stamped DRAFT so a copy that escapes
              cannot be mistaken for the real one. */}
          {onPreview && (
            <button
              type="button"
              disabled={previewing}
              onClick={onPreview}
              className="mb-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-surface-2 text-[15px] font-semibold text-ink disabled:opacity-50"
            >
              {previewing ? (
                <Loader2 size={15} strokeWidth={2} className="animate-spin" />
              ) : (
                <FileText size={15} strokeWidth={1.9} />
              )}
              {previewing ? 'Preparing…' : 'Preview the document'}
            </button>
          )}
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
        >
          <Lock size={17} strokeWidth={2} />
          {pending ? 'Locking…' : 'Finalise & lock'}
        </button>
        </>
      }
    >
      {summary.length > 0 && (
        <>
          <p className="section-label">In this report</p>
          <dl className="mt-1.5 overflow-hidden rounded-xl border border-hairline bg-surface">
            {summary.map((line) => (
              <div
                key={line.key}
                className="flex justify-between gap-4 border-t border-hairline px-3.5 py-2.5 first:border-t-0"
              >
                <dt className="shrink-0 text-caption text-muted">{line.label}</dt>
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
          <Clock size={15} strokeWidth={1.9} className="text-muted" />
          {finish.label.replace(/:$/, '')} — set to {readableNow()}
        </button>
      )}

      <ul className="mt-3 flex flex-col gap-2">
        {signatures.map((field) => {
          const signed = signedSlots.includes(field.slot)
          return (
            // An unsigned pad is a warning, not a refusal. A client who has
            // already driven off cannot sign, and the visit still has to be
            // recorded; a pad the form requires never reaches this sheet.
            <Row key={field.key} ok={signed} warn={!signed}>
              {field.label.replace(/:$/, '')} — {signed ? 'signed' : 'not signed'}
            </Row>
          )
        })}
        {/* Only where the form asks for evidence. A count of nothing on a form
            that never wanted a photo is a line that reads like a shortfall. */}
        {asksForPhotos && (
          <Row ok={photoCount > 0}>
            {photoCount === 0 ? 'No photos' : photoCount === 1 ? '1 photo' : `${photoCount} photos`}
          </Row>
        )}
      </ul>

      {recipients.length > 0 && (
        <div className="mt-4">
          <p className="section-label">Copy to</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {recipients.map((address) => (
              <span
                key={address}
                className="rounded-full bg-surface-2 px-2.5 py-1 text-caption text-ink-2"
              >
                {address}
              </span>
            ))}
          </div>
          {/* Honest about what locking does today: it records the recipients
              the form asked for. Sending is its own step, from the finished
              report, and saying "will be emailed" here would promise it. */}
          <p className="mt-1.5 text-caption text-muted">
            Recorded on the report. Send it from the report once it's locked.
          </p>
        </div>
      )}
    </Sheet>
  )
}

function Row({
  ok,
  warn,
  children,
}: {
  ok: boolean
  warn?: boolean
  children: React.ReactNode
}) {
  return (
    <li className={`flex items-center gap-2 text-body ${warn ? 'text-amber-ink' : 'text-ink-2'}`}>
      {warn ? (
        <TriangleAlert size={15} strokeWidth={2} className="shrink-0" />
      ) : (
        <Check
          size={15}
          strokeWidth={2.4}
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

function readableNow(): string {
  return new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit' }).format(new Date())
}

/**
 * Who the form says gets a copy — the client when the send-copy toggle is Yes,
 * plus whatever was typed into the form's own "Email Report To".
 *
 * Read through the semantics rather than the labels, because the three forms
 * word the same instruction three ways and the wording is reproduced verbatim.
 */
function recipientsOf(
  fields: Array<FieldDef>,
  data: Record<string, unknown>,
  context?: PresentContext | null,
): Array<string> {
  const out: Array<string> = []
  for (const field of fields) {
    if (field.semantic === 'sendCopyToClient' && data[field.key] === true) {
      const email = context?.client?.email
      if (email) out.push(email)
    }
    if (field.semantic === 'emailTo') {
      const value = data[field.key]
      const list = Array.isArray(value) ? value : [value]
      for (const entry of list) {
        if (typeof entry === 'string' && entry.trim() !== '') out.push(entry.trim())
      }
    }
  }
  return [...new Set(out)]
}
