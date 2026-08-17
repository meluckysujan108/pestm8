import { Lock } from 'lucide-react'

/**
 * Scope limits and disclaimers render in a grey inset card, visibly
 * non-editable (§2.3). They are what make the report defensible, so it must be
 * obvious they are not the technician's words to soften.
 */
export function BoilerplateBlock({ text }: { text: string }) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2 flex items-center gap-1.5">
        <Lock size={11} strokeWidth={2.4} />
        Standard terms — not editable
      </h3>
      <div className="rounded-2xl bg-surface-2 p-3.5">
        {text.split('\n\n').map((paragraph, i) => (
          <p
            key={i}
            className="text-secondary leading-relaxed text-ink-2 [&:not(:first-child)]:mt-2.5"
          >
            {paragraph}
          </p>
        ))}
      </div>
    </section>
  )
}
