import { useId, useState } from 'react'
import { Lock } from 'lucide-react'
import {
  COMMON_EMAIL_DOMAINS,
  emailDomain,
  emailProblem,
  emailTypoFix,
  isValidEmail,
} from '../../../../convex/lib/email'
import { isOffline, networkLookupsAllowed } from '#/lib/addressLookup'
import { checkEmailDomain } from '#/lib/emailDomainCheck'
import type { DomainMail } from '#/lib/emailDomainCheck'
import { RichTextView } from '../RichText'
import { FieldMessage } from '#/components/forms/FieldMessage'
import {
  describedBy,
  fieldInputClass,
  fieldMessageId,
} from '#/components/forms/FormField'
import { present } from '#/lib/reportTemplates/present'
import type { EditorProps } from './leafEditors'
import type { FieldDef } from '#/lib/reportTemplates'

/**
 * Controls for the kinds that print without asking — and the two that ask for
 * something the rest of the app already knows.
 *
 * `note`, `heading` and `derived` are read-only by construction: they hold
 * nothing in `data`, so their `onChange` is never called and their `value` is
 * always undefined. They live in the registry anyway because `FIELD_EDITORS`
 * is what stops a kind from rendering as nothing at all, and "renders as
 * nothing" is precisely the failure a printed warranty clause cannot afford.
 */

type Of<TKind extends FieldDef['kind']> = EditorProps<
  Extract<FieldDef, { kind: TKind }>
>

const TONE_CLASS = {
  note: 'border-hairline bg-surface-2',
  important: 'border-red/30 bg-red/5',
  warning: 'border-amber/30 bg-amber/5',
  statement: 'border-hairline bg-surface-2 italic',
} as const

export function NoteBlock({ field }: Of<'note'>) {
  const tone = field.tone ?? 'note'
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${TONE_CLASS[tone]}`}>
      {field.heading && (
        <p className="text-subhead font-semibold text-ink">
          {tone === 'important' ? `IMPORTANT: ${field.heading}` : field.heading}
        </p>
      )}
      <RichTextView doc={field.body} className="text-body text-ink-2" />
    </div>
  )
}

export function HeadingBlock({ field }: Of<'heading'>) {
  return (
    <div className="mt-2">
      <h3 className="text-body font-semibold text-ink">{field.text}</h3>
      {field.note && (
        <p className="mt-0.5 text-caption text-muted">{field.note}</p>
      )}
    </div>
  )
}

/**
 * A fact the document prints from a record. Shown the way iOS shows a setting
 * it will not let you change: the value, and a lock saying why there is no
 * control — not a disabled input, which reads as a control that is broken.
 *
 * The resolved value arrives with the section context in a later phase; until
 * then the row names its source so the row is never silently empty.
 */
export function DerivedRow({ field, ctx }: Of<'derived'>) {
  const shown = present(field, undefined, ctx.context)
  const text =
    shown.kind === 'text'
      ? shown.text
      : shown.kind === 'lines'
        ? shown.lines.join(', ')
        : null
  return (
    <div className="flex items-center gap-2 rounded-xl bg-surface-3 px-3.5 py-3">
      <Lock aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className={`text-body ${text ? 'text-ink' : 'text-muted'}`}>
        {/* Nothing on file yet: say where it will come from, so the row is never
            silently empty and the fix (update the record) is obvious. */}
        {text ?? `Not on the ${sourceWord(field.source)} record yet`}
      </span>
    </div>
  )
}

function sourceWord(source: string): string {
  const group = source.split('.')[0]
  return group === 'job' ? 'job' : group
}

export function MemberControl({ field, value, onChange, ctx }: Of<'member'>) {
  const roster = ctx.roster ?? []
  if (roster.length === 0) {
    return (
      <span className="text-body text-muted">
        No team members to choose from yet.
      </span>
    )
  }
  return (
    <span className="flex flex-col gap-1.5">
      {roster.map((member) => (
        <label
          key={member.id}
          className="flex items-center gap-2.5 rounded-xl border border-hairline bg-surface px-3 py-2.5"
        >
          <input
            type="radio"
            name={field.key}
            value={member.id}
            checked={value === member.id}
            onChange={() => onChange(member.id)}
            className="size-4 accent-red"
          />
          <span className="text-body text-ink">{member.name}</span>
        </label>
      ))}
    </span>
  )
}

/**
 * The addresses in what was typed into an "Email report to" box. Split on
 * commas, semicolons and line breaks, which is what people type (and paste)
 * between addresses. A space splits only when every piece on either side is
 * an address of its own, as in a pasted "a@x.com b@y.com": "john smith@x.com"
 * is one address with a mistake in it, not "john" and "smith@x.com" — the
 * split used to send the report to smith@x.com and print "john" as a
 * recipient.
 */
export function splitEmails(text: string): Array<string> {
  return text
    .split(/[,;\n\r]+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .flatMap((chunk) => {
      const pieces = chunk.split(/\s+/)
      return pieces.length > 1 && pieces.every((piece) => isValidEmail(piece))
        ? pieces
        : [chunk]
    })
}

const COMMON: ReadonlySet<string> = new Set(COMMON_EMAIL_DOMAINS)

/** The words for a domain DNS says takes no mail — EmailInput's, so a client
 * record and a report say the same thing about the same address. */
export function noMailMessage(domain: string): string {
  return `${domain} doesn't look like it receives email.`
}

/**
 * The domains among `addresses` that DNS says take no mail
 * (src/lib/emailDomainCheck.ts): "jan@smithpestcontrol.com.au" when the
 * business is smithpest.com.au passes every spelling rule, and a compliance
 * report sent there is simply gone.
 *
 * Asked only where EmailInput asks: not offline, not under a test runner, and
 * not for an address already refused or offered a typo fix (that line says
 * enough), nor a common provider's. Only the domain is sent. 'unknown' — no
 * signal, a slow resolver — says nothing, and the answer is only ever a
 * warning: nothing here stops a finalise or a send.
 */
export async function domainsWithoutMail(
  addresses: ReadonlyArray<string>,
  ask: (domain: string) => Promise<DomainMail> = checkEmailDomain,
): Promise<Array<string>> {
  if (!networkLookupsAllowed() || isOffline()) return []
  const domains = new Set<string>()
  for (const address of addresses) {
    if (emailProblem(address) !== null || emailTypoFix(address) !== null) {
      continue
    }
    const domain = emailDomain(address)
    if (domain !== null && !COMMON.has(domain)) domains.add(domain)
  }
  const answers = await Promise.all(
    [...domains].map(async (domain) =>
      (await ask(domain)) === 'no-mail' ? domain : null,
    ),
  )
  return answers.filter((domain): domain is string => domain !== null)
}

/** What is said under the box about one of its addresses. */
export type EmailLine = {
  index: number
  entry: string
  tone: 'error' | 'warning'
  text: string
  /** The address most likely meant, for the one-tap fix. */
  fix: string | null
}

/**
 * What to say about each address in the box. Only those `checked` — there
 * when the box was last left — are spoken about: the one still being typed
 * is not wrong yet. `noMail` is the domains DNS has said take no mail.
 */
export function emailLines(
  entries: ReadonlyArray<string>,
  checked: ReadonlyArray<string>,
  noMail: ReadonlyArray<string>,
): Array<EmailLine> {
  return entries.flatMap((entry, index): Array<EmailLine> => {
    if (!checked.includes(entry)) return []
    const problem = emailProblem(entry)
    const fix = emailTypoFix(entry)
    if (problem !== null) {
      return [{ index, entry, tone: 'error', text: problem, fix }]
    }
    if (fix !== null) {
      return [
        { index, entry, tone: 'warning', text: `Did you mean ${fix}?`, fix },
      ]
    }
    const domain = emailDomain(entry)
    return domain !== null && noMail.includes(domain)
      ? [
          {
            index,
            entry,
            tone: 'warning',
            text: noMailMessage(domain),
            fix: null,
          },
        ]
      : []
  })
}

/**
 * Extra recipients, stored as a list so the printed line and the addresses the
 * document is actually sent to cannot disagree.
 *
 * Every address here is sent the finalised document, so each is checked as
 * the box is left (convex/lib/email.ts): one that can never be delivered to is
 * named under the box, with the likely address as a fix where there is one;
 * a near miss of a common provider is offered as a fix. Stored as typed
 * either way — finalising is what refuses a bad one (validate.ts), so a
 * report half-filled in a driveway still saves.
 *
 * The control sits inside FieldRenderer's <label>, so the input is named with
 * aria-label: the lines under it, and their fix buttons, would otherwise
 * become part of its name.
 */
export function EmailsControl({ field, value, onChange }: Of<'emails'>) {
  const id = useId()
  const list = Array.isArray(value) ? (value as Array<string>) : []
  // What the technician has typed, kept as typed. Re-rendering from the parsed
  // list on every keystroke would swallow a trailing comma — the one character
  // needed to start a second address.
  const [draft, setDraft] = useState(list.join(', '))
  // The addresses as they were when the box was last left. Only those are
  // spoken about: the one still being typed is not wrong yet. Those already
  // there when the form opened were finished in an earlier sitting.
  const [checked, setChecked] = useState<ReadonlyArray<string>>(list)
  // Domains DNS has said take no mail, asked as the box is left. Only ever
  // added to: an answer about a domain stays true whichever address asked.
  const [noMail, setNoMail] = useState<ReadonlyArray<string>>([])

  const entries = splitEmails(draft)
  const said = emailLines(entries, checked, noMail)
  const errors = said.filter((line) => line.tone === 'error')
  const warnings = said.filter((line) => line.tone === 'warning')
  const errorId = fieldMessageId(id, 'error')
  const warningId = fieldMessageId(id, 'warning')

  function replace(index: number, fix: string) {
    const next = entries.map((entry, i) => (i === index ? fix : entry))
    setDraft(next.join(', '))
    onChange(next)
    // The fix button just pressed is gone; the cursor goes back to the box.
    document.getElementById(id)?.focus()
  }

  // One child of FieldRenderer's label, so its gap does not double the
  // space above each line under the box.
  return (
    <div>
      <input
        id={id}
        type="text"
        inputMode="email"
        // A customer's address goes here, and with "email" the phone offers
        // the technician's own — EmailInput turns it off for the same reason.
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={draft}
        placeholder={field.placeholder ?? 'name@example.com'}
        aria-label={field.label}
        aria-invalid={errors.length > 0 || undefined}
        aria-describedby={describedBy(
          errors.length > 0 && errorId,
          warnings.length > 0 && warningId,
        )}
        onChange={(e) => {
          setDraft(e.target.value)
          onChange(splitEmails(e.target.value))
        }}
        onBlur={() => {
          setDraft(entries.join(', '))
          setChecked(entries)
          void domainsWithoutMail(entries).then((found) => {
            if (found.some((domain) => !noMail.includes(domain))) {
              setNoMail((prev) => [...new Set([...prev, ...found])])
            }
          })
        }}
        className={fieldInputClass('lg', errors.length > 0)}
      />
      {/* Which address, by name: "the second one" is no help in a list of
          four typed on a phone. */}
      {errors.length > 0 && (
        <div id={errorId}>
          {errors.map((line) => (
            <FieldMessage
              key={`${line.index}:${line.entry}`}
              tone="error"
              fix={
                line.fix
                  ? {
                      label: `Use ${line.fix}`,
                      onApply: () => replace(line.index, line.fix ?? ''),
                    }
                  : undefined
              }
            >
              {entries.length > 1 ? `${line.entry}: ${line.text}` : line.text}
            </FieldMessage>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div id={warningId}>
          {warnings.map((line) => (
            <FieldMessage
              key={`${line.index}:${line.entry}`}
              tone="warning"
              fix={
                line.fix
                  ? {
                      label: 'Use it',
                      onApply: () => replace(line.index, line.fix ?? ''),
                    }
                  : undefined
              }
            >
              {entries.length > 1 ? `${line.entry}: ${line.text}` : line.text}
            </FieldMessage>
          ))}
        </div>
      )}
    </div>
  )
}
