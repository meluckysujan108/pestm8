import { useId } from 'react'
import { Switch } from 'radix-ui'
import { ROW_CLASS } from './ui'

/**
 * A report setting that takes effect the moment it is flipped: its name, a
 * line on what it does, and a switch. No Save — there is nothing to confirm.
 *
 * The whole row is the label, so the tap target is the row rather than a
 * 51px pill. The switch is named by the title alone, which is what a screen
 * reader and the e2e suite ask for it by; the line under it describes it.
 * That line wraps rather than truncating as a row's subtitle does: it says
 * what "off" means, and half of that sentence is a wrong one.
 */
export function ReportSwitchRow({
  title,
  description,
  checked,
  disabled,
  failed,
  onCheckedChange,
}: {
  title: string
  description?: string
  /** `undefined` while the setting is still loading: shown off, and locked. */
  checked: boolean | undefined
  disabled: boolean
  /** The last flip did not save. */
  failed: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const id = useId()
  const descriptionId = `${id}-description`
  const errorId = `${id}-error`
  const switchId = `${id}-switch`

  // A row, not a <label>: the failure line sits beside the words, and inside
  // a label it would toggle the switch when tapped.
  return (
    <div className={ROW_CLASS}>
      <span className="min-w-0 flex-1">
        <label htmlFor={switchId} className="block">
          <span className="block text-body text-ink">{title}</span>
          {description && (
            <span id={descriptionId} className="block text-caption text-muted">
              {description}
            </span>
          )}
        </label>
        {failed && (
          <span
            id={errorId}
            role="alert"
            className="block text-caption text-amber-ink"
          >
            Could not save that. Check your signal and try again.
          </span>
        )}
      </span>
      <Switch.Root
        id={switchId}
        aria-label={title}
        aria-describedby={
          [description && descriptionId, failed && errorId]
            .filter(Boolean)
            .join(' ') || undefined
        }
        checked={checked ?? false}
        disabled={disabled || checked === undefined}
        onCheckedChange={onCheckedChange}
        className="relative h-[31px] w-[51px] shrink-0 rounded-full bg-fill-track transition data-[state=checked]:bg-green disabled:opacity-50"
      >
        <Switch.Thumb className="block size-[27px] translate-x-0.5 rounded-full bg-white shadow-elevation transition-transform will-change-transform data-[state=checked]:translate-x-[22px]" />
      </Switch.Root>
    </div>
  )
}
