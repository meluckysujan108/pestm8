import { forwardRef } from 'react'
import { createLink } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { PRIMARY_BUTTON } from '#/components/primitives/buttons'
import { ABOVE_DOCK } from '#/components/shell/dock'

/**
 * The pieces every Settings page is built from, so the hub and each page it
 * opens read as one grouped list rather than a stack of forms.
 *
 * The rules they carry, which the pages should not restate:
 *  - A group's heading sits OUTSIDE its card, in small grey capitals; a field's
 *    label sits inside, in the body weight. The two used to share a style, so
 *    "Your details" and "Name" looked like the same kind of thing.
 *  - Rows inside a card are divided by a hairline, never boxed in their own
 *    card.
 *  - At most one line of help, under the group, in the group's footer.
 *  - Anything destructive goes last on its page (`DangerGroup`).
 */

/** Colours an icon tile may take — the palette's own tints, which hold their
 * contrast in both themes. */
export type Tint = 'blue' | 'green' | 'red' | 'orange' | 'grey' | 'amber'

// Only the saturated system colours: they are the same in both themes. The
// `-ink` tokens invert for dark mode (orange-ink turns peach, grey-ink turns
// pale), which put a white glyph on a pale tile.
const TINT: Record<Tint, string> = {
  blue: 'bg-blue text-white',
  green: 'bg-green text-white',
  // A white glyph, not text: 3:1 is its bar, which the brand red clears.
  // eslint-disable-next-line no-restricted-syntax -- icon, not text
  red: 'bg-red text-white',
  orange: 'bg-amber text-white',
  amber: 'bg-amber text-white',
  grey: 'bg-muted-2 text-white',
}

/** The small rounded square an iOS settings row leads with. */
export function IconTile({
  icon: Icon,
  tint = 'blue',
}: {
  icon: LucideIcon
  tint?: Tint
}) {
  return (
    <span
      aria-hidden
      className={`flex size-[30px] shrink-0 items-center justify-center rounded-[8px] ${TINT[tint]}`}
    >
      <Icon size={17} strokeWidth={2} />
    </span>
  )
}

/**
 * A titled card of rows. `title` is the heading above it and `footer` the one
 * line of help below; either may be left out.
 */
export function SettingsGroup({
  title,
  footer,
  children,
  className = '',
  id,
}: {
  title?: string
  footer?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section className={`mt-6 first:mt-0 ${className}`} aria-labelledby={id}>
      {title && (
        <h2 id={id} className="section-label mb-2 px-1">
          {title}
        </h2>
      )}
      <div className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-surface shadow-elevation">
        {children}
      </div>
      {footer && (
        <div className="mt-2 px-1 text-caption text-muted">{footer}</div>
      )}
    </section>
  )
}

/** A badge on a row, only ever for something that needs doing. */
export function RowBadge({
  tone,
  children,
}: {
  tone: 'amber' | 'red' | 'green' | 'grey'
  children: ReactNode
}) {
  const style = {
    // amber-ink clears the 4.5 this 12px text needs (styles.css).
    amber: 'bg-amber-bg text-amber-ink border-amber-line',
    red: 'bg-red-bg text-red-ink border-red-line',
    green: 'bg-green-bg text-green-ink border-green-line',
    grey: 'bg-grey-bg text-grey-ink border-grey-line',
  }[tone]
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-[1px] text-[12px] font-semibold ${style}`}
    >
      {children}
    </span>
  )
}

type RowBodyProps = {
  icon?: LucideIcon
  tint?: Tint
  /** Anything in the icon's place — an initial, a colour dot, a logo. */
  leading?: ReactNode
  title: ReactNode
  /** One line under the title. */
  subtitle?: ReactNode
  /** The current value, right-aligned and truncated. */
  value?: ReactNode
  badge?: ReactNode
  chevron?: boolean
}

/** What a row shows: the leading tile, the title (and a subtitle), then the
 * value, a badge and a chevron on the right. */
export function RowBody({
  icon,
  tint,
  leading,
  title,
  subtitle,
  value,
  badge,
  chevron = false,
}: RowBodyProps) {
  return (
    <>
      {leading ?? (icon ? <IconTile icon={icon} tint={tint} /> : null)}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-ink">{title}</span>
        {subtitle && (
          <span className="block truncate text-caption text-muted">
            {subtitle}
          </span>
        )}
      </span>
      {value !== undefined && value !== null && value !== '' && (
        <span className="min-w-0 max-w-[45%] truncate text-right text-body text-muted">
          {value}
        </span>
      )}
      {badge}
      {chevron && (
        <ChevronRight
          aria-hidden
          size={17}
          strokeWidth={2.2}
          className="shrink-0 text-muted-2"
        />
      )}
    </>
  )
}

// The focus ring is inset: a group's card clips its rows (overflow-hidden),
// and would cut an outer ring off. The background shift alone is 1.1:1.
export const ROW_CLASS =
  'flex min-h-[52px] w-full items-center gap-3 px-3.5 py-2.5 text-left outline-none transition focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue active:bg-surface-2'

/** A row that is not a link: a switch, a read-only value. */
export function SettingsRow(
  props: RowBodyProps & { className?: string; children?: ReactNode },
) {
  const { className = '', children, ...body } = props
  return (
    <div className={`${ROW_CLASS} ${className}`}>
      <RowBody {...body} />
      {children}
    </div>
  )
}

const RowAnchor = forwardRef<
  HTMLAnchorElement,
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'title'> & RowBodyProps
>(function RowAnchor(
  { icon, tint, leading, title, subtitle, value, badge, className, ...rest },
  ref,
) {
  return (
    <a ref={ref} {...rest} className={`${ROW_CLASS} ${className ?? ''}`}>
      <RowBody
        icon={icon}
        tint={tint}
        leading={leading}
        title={title}
        subtitle={subtitle}
        value={value}
        badge={badge}
        chevron
      />
    </a>
  )
})

/**
 * A row that opens a page: `to`/`params`/`search` as on any `Link`, typed by
 * the router, with the row's own props beside them.
 */
export const SettingsLinkRow = createLink(RowAnchor)

const BackAnchor = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement>
>(function BackAnchor({ children, className, ...rest }, ref) {
  return (
    <a
      ref={ref}
      {...rest}
      className={`relative tap-target -ml-1.5 mb-0.5 inline-flex min-h-7 items-center gap-0.5 text-body font-medium text-blue ${className ?? ''}`}
    >
      <ChevronLeft aria-hidden size={20} strokeWidth={2} />
      {children}
    </a>
  )
})

/** "‹ Settings", in the header's kicker slot on every page the hub opens. */
export const BackLink = createLink(BackAnchor)

/** A field's label inside a card: body weight, not a group heading. */
export const FIELD_LABEL = 'text-caption font-medium text-ink-2'

/** A labelled control inside a card, as one row of it. */
export function FieldRow({
  id,
  label,
  hint,
  children,
}: {
  /** The control's id, so the label names it — and only it: warning lines
   * and their fix buttons under a phone or email must not join its name. */
  id: string
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3.5 py-3">
      <label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </label>
      <div>{children}</div>
      {hint && <p className="text-caption text-muted">{hint}</p>}
    </div>
  )
}

/**
 * The Save button for a page's form, shown only while there is something to
 * save (or a save still in flight, or one just made, so "Saved" is seen).
 *
 * Pinned above the phone's dock, so a long form's Save is never a scroll away.
 * On a wide screen there is no dock and it sits at the foot of the column.
 *
 * 55px is the dock's own height (MobileDock: its border, padding, glyph and
 * label), not the 68px `main` pads by: at 68 the page scrolled through a
 * strip between the two bars.
 */
export function SaveBar({
  visible,
  pending,
  label,
  disabled = false,
  form,
}: {
  visible: boolean
  pending: boolean
  /** "Save", "Saved", "Save anyway" — whatever the form's state says. */
  label: string
  disabled?: boolean
  /** The id of the form it submits, when it is rendered outside it. */
  form?: string
}) {
  if (!visible) return null
  return (
    <div
      className={`sticky ${ABOVE_DOCK} z-20 -mx-4 mt-4 border-t border-hairline bg-canvas/90 px-4 py-3 backdrop-blur lg:bottom-0`}
    >
      <button
        type="submit"
        form={form}
        disabled={pending || disabled}
        className={`${PRIMARY_BUTTON} w-full`}
      >
        {pending ? 'Saving…' : label}
      </button>
      {/* The button's word changing is silent to a screen reader; this says
          it. Mounted with the bar, so it is already listening when "Saved"
          arrives. */}
      <span role="status" className="sr-only">
        {!pending && label === 'Saved' ? 'Saved' : ''}
      </span>
    </div>
  )
}

/** The last group on a page: its destructive actions, in red. */
export function DangerGroup({
  children,
  footer,
}: {
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <SettingsGroup className="mt-8" footer={footer}>
      {children}
    </SettingsGroup>
  )
}

/** A full-width red text button, as a row of a `DangerGroup`. */
export const DANGER_ROW_CLASS = `${ROW_CLASS} justify-center text-body font-semibold text-red disabled:opacity-50`

/** The padding every Settings page's content sits in. */
export function SettingsBody({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-8 pt-5">
      {children}
    </div>
  )
}
