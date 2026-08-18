export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="rounded-2xl border border-hairline bg-surface px-4 py-10 text-center shadow-elevation">
      <p className="text-row-title text-ink">{title}</p>
      {body && <p className="mt-1 text-body text-muted">{body}</p>}
    </div>
  )
}
