import { Lock } from 'lucide-react'
import { RichTextView } from './RichText'
import type { RichDoc } from '#/lib/reportTemplates'

/**
 * Scope limits and disclaimers render in a grey inset card, visibly
 * non-editable (§2.3). They are what make the report defensible, so it must be
 * obvious they are not the technician's words to soften.
 *
 * A verbatim template carries structured `terms` and an empty `boilerplate`;
 * a v1 template carries the reverse. Neither prints an empty card — a card
 * titled "Standard terms" with nothing in it reads as terms that went missing.
 */
export function BoilerplateBlock({
  text,
  terms,
  heading,
}: {
  text: string
  terms?: RichDoc
  heading?: string
}) {
  if (!terms && text.trim() === '') return null

  return (
    <section className="mt-6">
      <h3 className="section-label mb-2 flex items-center gap-1.5">
        <Lock size={11} strokeWidth={2.4} />
        {heading ?? 'Standard terms — not editable'}
      </h3>
      <div className="rounded-2xl bg-surface-2 p-3.5">
        {terms ? (
          <RichTextView doc={terms} className="text-caption leading-relaxed text-ink-2" />
        ) : (
          text.split('\n\n').map((paragraph, i) => (
            <p
              key={i}
              className="text-caption leading-relaxed text-ink-2 [&:not(:first-child)]:mt-2.5"
            >
              {paragraph}
            </p>
          ))
        )}
      </div>
    </section>
  )
}
