import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useConvexAction } from '@convex-dev/react-query'
import { Check, User, Users } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { EmailInput } from '#/components/forms/EmailInput'
import { FormAlert } from '#/components/forms/FormAlert'
import {
  SaveWarningsPanel,
  SaveWarningsProvider,
  useLatest,
  useSaveWarnings,
} from '#/components/forms/SaveWarnings'
import { InviteLinkCard } from '#/components/settings/InviteLinkCard'
import { FIELD_LABEL } from '#/components/settings/ui'
import { useHydrated } from '#/lib/useHydrated'
import { AsideButton, SetupFrame } from './SetupFrame'
import type { LucideIcon } from 'lucide-react'
import type { BusinessRecord } from '#/components/settings/BusinessSection'

export type TeamShape = 'solo' | 'team'

/** Settings → Team's own words for an invite that did not go through. */
const INVITE_COPY = {
  ALREADY_MEMBER: 'They’re already on your team.',
  INVALID_EMAIL: 'Check that email address.',
  offline:
    'Could not create the invite: this device is offline. Try again when you have signal.',
  default: 'Could not create the invite. Check your connection and try again.',
}

/**
 * Step 4: who else does the work. "Just me" and on; a team gets the chance to
 * invite one person now — most start with one, and the rest follow from
 * Settings → Team — with the same single-use link Settings makes, sent in
 * their own text. Inviting is never required to move on.
 */
export function TeamStep({
  business,
  inviterName,
  onBack,
  onDone,
}: {
  business: BusinessRecord
  inviterName?: string
  onBack: () => void
  onDone: (team: TeamShape | null) => Promise<void>
}) {
  const hydrated = useHydrated()
  const emailId = useId()
  const [team, setTeam] = useState<TeamShape | null>(null)
  const [email, setEmail] = useState('')
  const [links, setLinks] = useState<Array<{ email: string; url: string }>>([])
  const warnings = useSaveWarnings()
  const latestEmail = useLatest(email)

  const createInvite = useConvexAction(api.invitations.create)
  const invite = useMutation({
    mutationFn: (to: string) =>
      createInvite({
        businessId: business._id,
        email: to,
        role: 'subcontractor',
      }),
    onSuccess: ({ url }, to) => {
      setEmail('')
      setLinks((prev) => [...prev, { email: to, url }])
    },
  })

  const finish = useMutation({ mutationFn: onDone })

  return (
    <SetupFrame
      step="team"
      title="Who works with you?"
      lede="Technicians and subcontractors each get their own account, and see the jobs you give them."
      onBack={onBack}
      aside={
        <AsideButton
          onClick={() => finish.mutate(null)}
          disabled={finish.isPending}
        >
          Skip
        </AsideButton>
      }
    >
      <div
        role="radiogroup"
        aria-label="Who works with you"
        className="mt-6 grid grid-cols-2 gap-3"
      >
        <Choice
          icon={User}
          title="Just me"
          detail="I do the jobs myself."
          selected={team === 'solo'}
          onSelect={() => setTeam('solo')}
        />
        <Choice
          icon={Users}
          title="Me and a team"
          detail="Others do jobs for me."
          selected={team === 'team'}
          onSelect={() => setTeam('team')}
        />
      </div>

      {team === 'team' && (
        <section className="mt-6 duration-300 animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none">
          {links.map((link) => (
            <div
              key={link.url}
              className="mb-4 rounded-2xl border border-hairline bg-surface p-4 shadow-elevation"
            >
              <InviteLinkCard
                email={link.email}
                url={link.url}
                businessName={business.name}
                inviterName={inviterName}
              />
            </div>
          ))}

          <SaveWarningsProvider value={warnings}>
            <form
              className="flex flex-col gap-1.5 rounded-2xl border border-hairline bg-surface p-4 shadow-elevation"
              onSubmit={(e) =>
                warnings.guard(e, () => invite.mutateAsync(latestEmail.current))
              }
            >
              <label htmlFor={emailId} className={FIELD_LABEL}>
                {links.length === 0
                  ? 'Invite someone now'
                  : 'Invite someone else'}
              </label>
              <EmailInput
                id={emailId}
                value={email}
                onChange={setEmail}
                required
                placeholder="kevin@example.com"
              />
              <p className="text-caption text-muted">
                You’ll get a link to text them. It works once, for that address
                only. They join as a subcontractor and see just the jobs you
                give them.
              </p>
              <SaveWarningsPanel className="mt-1" />
              <FormAlert
                error={invite.isError ? invite.error : null}
                copy={INVITE_COPY}
                className="mt-1"
              />
              <button
                type="submit"
                disabled={invite.isPending || !hydrated}
                className="mt-2 h-11 w-full rounded-xl bg-surface-2 text-[16px] font-semibold text-blue transition active:scale-[.975] disabled:opacity-50"
              >
                {invite.isPending
                  ? 'Creating…'
                  : warnings.saveLabel('Create invite link')}
              </button>
            </form>
          </SaveWarningsProvider>
          <p className="mt-3 px-1 text-caption text-muted">
            Invite more people, and choose what each can see, in Settings →
            Team.
          </p>
        </section>
      )}

      <FormAlert
        error={finish.isError ? finish.error : null}
        className="mt-4"
      />

      <button
        type="button"
        onClick={() => finish.mutate(team)}
        disabled={!team || finish.isPending || !hydrated}
        className="mt-8 h-12 w-full shrink-0 rounded-xl bg-red text-[17px] font-semibold text-white shadow-red transition active:scale-[.975] disabled:opacity-50"
      >
        {finish.isPending ? 'Saving…' : 'Continue'}
      </button>
    </SetupFrame>
  )
}

function Choice({
  icon: Icon,
  title,
  detail,
  selected,
  onSelect,
}: {
  icon: LucideIcon
  title: string
  detail: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`relative flex flex-col items-start rounded-2xl border bg-surface p-4 text-left shadow-elevation transition active:scale-[.98] ${
        selected ? 'border-blue ring-2 ring-blue/30' : 'border-hairline'
      }`}
    >
      <span
        aria-hidden
        className={`flex size-10 items-center justify-center rounded-full ${selected ? 'bg-blue text-white' : 'bg-surface-3 text-ink-2'}`}
      >
        <Icon size={20} strokeWidth={1.9} />
      </span>
      <span className="mt-3 text-[16px] font-semibold text-ink">{title}</span>
      <span className="mt-0.5 text-caption text-muted">{detail}</span>
      {selected && (
        <Check
          aria-hidden
          size={18}
          strokeWidth={2.4}
          className="absolute right-3 top-3 text-blue"
        />
      )}
    </button>
  )
}
