import { AlertTriangle } from 'lucide-react'

/**
 * The durable notice cannot be automated (§1.4): AS 3660.2 / NCC require a
 * physical notice fixed to the building. The app produces the text; the warning
 * exists so nobody mistakes generating it for having done it.
 */
export function DurableNoticePreview({ text }: { text: string }) {
  return (
    <section className="mt-6">
      <h3 className="section-label mb-2">Durable notice</h3>

      <pre className="overflow-x-auto rounded-2xl border border-hairline bg-surface p-3.5 font-mono text-[12px] leading-relaxed text-ink shadow-elevation">
        {text}
      </pre>

      <p className="mt-2 flex gap-2 rounded-xl border border-amber-line bg-amber-bg px-3 py-2.5 text-secondary text-amber-ink">
        <AlertTriangle size={15} strokeWidth={2} className="mt-0.5 shrink-0" />
        <span>
          This notice must be physically fixed to the building, usually inside
          the meter box. Finalising this certificate adds it to your follow-ups
          — it is not done until someone fixes it on site.
        </span>
      </p>
    </section>
  )
}
