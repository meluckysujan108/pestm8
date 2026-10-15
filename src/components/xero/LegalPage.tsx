import { FormAlert } from '#/components/forms/FormAlert'
import type { ReactNode } from 'react'

/**
 * The frame the terms of use and the privacy policy are read in
 * (`routes/terms.tsx`, `routes/privacy.tsx`). Xero's developer terms ask an
 * app that connects to it to have both, at addresses anyone can open, so
 * these pages have no sign-in and no app around them: a person reading them
 * may never have used PestM8, and the Settings pages open them in a tab of
 * their own.
 *
 * Built like an entry screen (design system §3), only top-aligned, since it
 * is something to read rather than a form to fill in; wider, at a Settings
 * page's reading width.
 */
export function LegalPage({
  title,
  lede,
  changed,
  draft = false,
  children,
  other,
}: {
  title: string
  lede: string
  /** The day the text last changed ("6 October 2026"), said at the top:
   * which version someone agreed to. */
  changed: string
  /** True until the business owner has approved the text; the page says
   * so at the top. */
  draft?: boolean
  children: ReactNode
  /** The other page, linked at the foot. */
  other: { href: string; label: string }
}) {
  return (
    <main className="mx-auto w-full max-w-[640px] px-6 pb-16 pt-[calc(40px+env(safe-area-inset-top))]">
      <p className="section-label mb-2">PestM8</p>
      <h1 className="text-page-title text-ink">{title}</h1>
      <p className="mt-2 text-body text-muted">{lede}</p>
      <p className="mt-1 text-caption text-grey-ink">Last changed {changed}</p>
      {draft && (
        <FormAlert className="mt-4">
          A draft, for the business owner to approve. It is not in force yet.
        </FormAlert>
      )}
      {children}
      <footer className="mt-12 flex flex-wrap gap-x-6 border-t border-hairline pt-4">
        <a
          href={other.href}
          className="flex min-h-11 items-center text-body text-blue"
        >
          {other.label}
        </a>
        <a href="/" className="flex min-h-11 items-center text-body text-blue">
          Open PestM8
        </a>
      </footer>
    </main>
  )
}

/** One heading and what it says. */
export function LegalSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="mt-8">
      <h2 className="text-row-title text-ink">{title}</h2>
      <div className="mt-2 flex flex-col gap-3 text-body text-ink-2">
        {children}
      </div>
    </section>
  )
}

/** A plain list inside a section. */
export function LegalList({ items }: { items: ReadonlyArray<ReactNode> }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}
