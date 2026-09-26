import { useQuery } from '@tanstack/react-query'
import { convexQuery } from '@convex-dev/react-query'
import { Link } from '@tanstack/react-router'
import { DropdownMenu } from 'radix-ui'
import { BadgeCheck, Check, ChevronDown, Users } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { useAccess, useActing, useViewMode } from '#/lib/access'
import { roleLabel } from '#/lib/assignees'
import { useHydrated } from '#/lib/useHydrated'
import { useSetView } from '#/lib/useSetView'
import type { ReactNode } from 'react'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The owner's "whose work am I looking at": God view, just his own jobs, or
 * somebody else's account — beside the + in the header, on every screen that
 * has one.
 *
 * Rendered only when `access.me` says this person gets it, so the rule
 * (`canChooseView`) lives on the server and nowhere here. A Radix
 * DropdownMenu, not a Popover: this is a single choice among options, which
 * is what a menu of radio items says to a screen reader — and a Popover's
 * `role=dialog` would collide with the unscoped dialog locators all over e2e.
 * Everyone else who may work in another account does it from Settings.
 *
 * The trigger stays the 36px of its neighbours, so the header — and the
 * schedule's sticky week strip pinned beneath it — never moves. On a phone it
 * is a glyph alone; readable at a glance from the ladder, which is the point:
 * a group for everyone, his own initial for his own jobs, an amber ring when
 * he is working in someone else's account.
 */
export function ViewMenu({
  businessId,
  businessSlug,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
}) {
  const mode = useViewMode()
  const acting = useActing()
  const access = useAccess()
  // Per src/lib/useHydrated.ts: before hydration this would open nothing.
  const hydrated = useHydrated()
  // Not suspense: the header must never wait on a list of names. The trigger's
  // shape comes from `access.me`, already loaded; details fill in after.
  // And only for someone who gets the menu: everyone else would be holding a
  // subscription open on every page to be told `null`.
  const { data: options } = useQuery({
    ...convexQuery(api.views.options, { businessId }),
    enabled: mode !== null,
  })
  const setView = useSetView(businessId)

  if (mode === null) return null

  const me = options?.me
  const accounts = options?.accounts ?? []
  const inside =
    mode === 'account'
      ? accounts.find((a) => a.membershipId === acting.membershipId)
      : undefined

  const label =
    mode === 'everyone'
      ? 'God view'
      : mode === 'mine'
        ? 'My jobs'
        : inside?.name || acting.name || 'Their account'

  // One value across all the radio items: a view's own name, or the id of the
  // account being worked in. None of them while an old read-only "view as" is
  // still on: he is not in God view then, and picking it must be able to take
  // him there (`views.set` clears the old selection).
  const current =
    mode === 'account' ? acting.membershipId : access.viewingAs ? '' : mode

  const choose = (next: string) => {
    if (next === current || setView.isPending) return
    if (next === 'everyone' || next === 'mine') {
      setView.mutate({ kind: next })
      return
    }
    const account = accounts.find((a) => a.membershipId === next)
    if (account) {
      setView.mutate({ kind: 'account', membershipId: account.membershipId })
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        type="button"
        // Also while a choice is saving, so a second tap cannot land in the
        // middle of the first and be silently dropped.
        disabled={!hydrated || setView.isPending}
        aria-label="Whose jobs to show"
        className="relative tap-target flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-surface-2 text-ink-2 transition active:scale-[.95] disabled:opacity-50 md:pr-3"
      >
        {mode === 'everyone' ? (
          <Glyph>
            <Users size={18} strokeWidth={1.7} />
          </Glyph>
        ) : mode === 'mine' ? (
          <Initial name={me?.name ?? ''} colour={me?.colour} />
        ) : (
          <Initial
            name={inside?.name ?? acting.name ?? ''}
            colour={inside?.colour}
            ring
          />
        )}
        <span className="hidden max-w-28 truncate text-caption font-semibold md:inline">
          {label}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2.2}
          className="hidden text-muted md:block"
        />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 max-h-[70vh] w-64 overflow-y-auto rounded-2xl border border-hairline bg-surface p-1.5 shadow-elevation"
        >
          <DropdownMenu.RadioGroup value={current} onValueChange={choose}>
            <Choice
              value="everyone"
              glyph={
                <Glyph>
                  <Users size={16} strokeWidth={2} />
                </Glyph>
              }
              title="God view"
              caption="Everyone’s jobs"
            />
            <Choice
              value="mine"
              glyph={<Initial name={me?.name ?? ''} colour={me?.colour} />}
              title={me?.name || 'Me'}
              caption="Just my jobs"
            />

            {/* The first open on a slow phone can beat the names here; an
                empty section would read as "nobody to switch to". */}
            {options === undefined && (
              <p className="px-2.5 py-2 text-caption text-muted">
                Loading the team…
              </p>
            )}
            {accounts.length > 0 && (
              <>
                <DropdownMenu.Separator className="my-1 border-t border-hairline" />
                {/* "Work in" rather than "view as", as on the Settings hub:
                    what follows is writing under their name. */}
                <DropdownMenu.Label className="section-label px-2.5 pb-1 pt-2">
                  Work in another account
                </DropdownMenu.Label>
                {accounts.map((a) => (
                  <Choice
                    key={a.membershipId}
                    value={a.membershipId}
                    glyph={<Initial name={a.name} colour={a.colour} />}
                    title={a.name || roleLabel(a.role)}
                    caption={roleLabel(a.role)}
                  />
                ))}
              </>
            )}
          </DropdownMenu.RadioGroup>

          {/* Working his own jobs means signing his own certificates, which a
              blank licence number refuses — better said here than at the end
              of an inspection. */}
          {me?.licenceMissing && (
            <>
              <DropdownMenu.Separator className="my-1 border-t border-hairline" />
              <DropdownMenu.Item asChild>
                <Link
                  to="/$businessSlug/settings/licence"
                  params={{ businessSlug }}
                  className="flex items-start gap-2 rounded-xl px-2.5 py-2 text-caption text-muted outline-none transition data-[highlighted]:bg-surface-2"
                >
                  <BadgeCheck
                    size={16}
                    strokeWidth={2}
                    className="mt-px shrink-0 text-blue"
                  />
                  Add your licence number in Settings so you can sign
                  certificates.
                </Link>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function Choice({
  value,
  glyph,
  title,
  caption,
}: {
  value: string
  glyph: ReactNode
  title: string
  caption: string
}) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 outline-none transition data-[highlighted]:bg-surface-2"
    >
      {glyph}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-row-title text-ink">{title}</span>
        <span className="block truncate text-caption text-muted">
          {caption}
        </span>
      </span>
      <DropdownMenu.ItemIndicator>
        <Check size={16} strokeWidth={2.2} className="text-blue" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  )
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-2">
      {children}
    </span>
  )
}

/** A person as a coloured initial — theirs, in their schedule colour. */
function Initial({
  name,
  colour,
  ring = false,
}: {
  name: string
  colour?: string
  ring?: boolean
}) {
  return (
    <span
      aria-hidden
      className={[
        'flex size-9 shrink-0 items-center justify-center rounded-full text-body font-semibold text-white',
        ring ? 'ring-2 ring-amber ring-offset-2 ring-offset-canvas' : '',
      ].join(' ')}
      style={{ backgroundColor: colour ?? 'var(--color-muted)' }}
    >
      {name.trim().charAt(0).toUpperCase()}
    </span>
  )
}
