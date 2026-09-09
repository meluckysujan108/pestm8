import { Segmented } from '#/components/primitives/Segmented'
import type { Condition, Scalar } from '#/lib/reportTemplates/visibility'

/**
 * v1 scope, by design: a single leaf condition against one other field
 * declared earlier in the template — never the full recursive `all`/`any`/
 * `not` composition `Condition` itself allows. None of the 4 built-in
 * templates use `visibleWhen` at all, so this loses nothing today, and the
 * stored shape is still the full `Condition` type — a richer editor later
 * needs no data migration, only a bigger UI.
 *
 * The `when` field is a dropdown restricted to keys already declared earlier
 * in the template, not free text — the one thing that keeps a template from
 * ever storing a dangling reference to a field that doesn't exist (or one
 * declared later, which `pruneHidden`/`isVisible` would evaluate against a
 * value that hasn't been asked for yet).
 */

type MatchType = 'eq' | 'oneOf' | 'includes' | 'filled'

function matchTypeOf(condition: Condition): MatchType | null {
  if ('eq' in condition) return 'eq'
  if ('oneOf' in condition) return 'oneOf'
  if ('includes' in condition) return 'includes'
  if ('filled' in condition) return 'filled'
  return null // all/any/not — outside this editor's v1 scope
}

function parseScalar(raw: string): Scalar {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  return raw.trim() !== '' && !Number.isNaN(n) ? n : raw
}

function valueText(condition: Condition): string {
  if ('eq' in condition) return String(condition.eq)
  if ('oneOf' in condition) return condition.oneOf.join(', ')
  if ('includes' in condition) return String(condition.includes)
  return ''
}

export function VisibleWhenEditor({
  value,
  onChange,
  candidates,
}: {
  value: Condition | undefined
  onChange: (next: Condition | undefined) => void
  candidates: Array<{ key: string; label: string }>
}) {
  const matchType = value ? matchTypeOf(value) : null
  const when = value && 'when' in value ? value.when : (candidates[0]?.key ?? '')

  if (candidates.length === 0) {
    return (
      <p className="text-caption text-muted">
        Add another field earlier in this template first to make this one
        conditional.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-surface-2 p-3">
      <label className="flex items-center justify-between gap-2">
        <span className="text-body text-ink">Only show conditionally</span>
        <input
          type="checkbox"
          checked={value !== undefined}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? { when: candidates[0].key, filled: true }
                : undefined,
            )
          }
          className="size-5"
        />
      </label>

      {value !== undefined && matchType !== null && (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="section-label">When this field…</span>
            <select
              value={when}
              onChange={(e) => onChange(rebuild(matchType, e.target.value, value))}
              className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
            >
              {candidates.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <Segmented
            label="Match type"
            value={matchType}
            options={[
              { value: 'filled', label: 'Is answered' },
              { value: 'eq', label: 'Equals' },
              { value: 'oneOf', label: 'One of' },
              { value: 'includes', label: 'Includes' },
            ]}
            onChange={(next) => onChange(rebuild(next, when, value))}
          />

          {matchType !== 'filled' && (
            <label className="flex flex-col gap-1.5">
              <span className="section-label">
                {matchType === 'oneOf' ? 'Values (comma-separated)' : 'Value'}
              </span>
              <input
                value={valueText(value)}
                onChange={(e) => onChange(withValue(matchType, when, e.target.value))}
                placeholder={matchType === 'eq' ? 'e.g. true, or a choice label' : ''}
                className="h-11 w-full rounded-xl bg-surface-3 px-3 text-[15px] text-ink outline-none focus:ring-2 focus:ring-blue"
              />
            </label>
          )}
        </>
      )}
    </div>
  )
}

/** Carries the value text over when only `when`/match type changed, so
 * switching the trigger field doesn't discard what was already typed. */
function rebuild(matchType: MatchType, when: string, previous: Condition): Condition {
  const text = matchType === matchTypeOf(previous) ? valueText(previous) : ''
  return withValue(matchType, when, text)
}

function withValue(matchType: MatchType, when: string, text: string): Condition {
  switch (matchType) {
    case 'filled':
      return { when, filled: true }
    case 'eq':
      return { when, eq: parseScalar(text) }
    case 'includes':
      return { when, includes: parseScalar(text) }
    case 'oneOf':
      return {
        when,
        oneOf: text
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map(parseScalar),
      }
  }
}
