import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useConvexMutation } from '@convex-dev/react-query'
import { IdCard } from 'lucide-react'
import { api } from '../../../convex/_generated/api'
import { isRegulatedTemplate } from '../../../convex/lib/capabilities'
import { FormAlert } from '#/components/forms/FormAlert'
import { fieldInputClass } from '#/components/forms/FormField'
import { LICENCE_LABEL } from '#/lib/au'
import { useAccess } from '#/lib/access'
import { useHydrated } from '#/lib/useHydrated'
import type { ReportTemplate } from '../../../convex/lib/capabilities'
import type { Id } from '../../../convex/_generated/dataModel'

/** Who can put a missing licence right, from where this person stands. */
export type LicenceFix = 'self' | 'team' | 'owner'

/**
 * Whether this draft will be refused at Finalise for want of a licence
 * number (`HOLDER_LICENCE_MISSING`), and who can fix it: the author, on
 * their own account; the owner, on the author's Team page; or, for anyone
 * else, the owner. Null when it will not be refused for this.
 */
export function licenceFixFor({
  template,
  author,
  callerMembershipId,
  viewerIsOwner,
}: {
  template: ReportTemplate
  author: { _id: Id<'memberships'>; licenceNumber?: string } | null
  callerMembershipId: Id<'memberships'>
  viewerIsOwner: boolean
}): LicenceFix | null {
  if (!author || !isRegulatedTemplate(template)) return null
  if (author.licenceNumber?.trim()) return null
  if (author._id === callerMembershipId) return 'self'
  return viewerIsOwner ? 'team' : 'owner'
}

/**
 * The missing licence, said when the certificate is started rather than
 * discovered at its last step: this form will not finalise without the
 * author's licence number, and here is how to add it.
 *
 * The author adds their own right here — the same field, and the same rule,
 * as Settings → Licences — and the notice goes the moment it is saved, since
 * the report's author is read live. The owner gets a way to that person's
 * Team page; anyone else, who to ask.
 */
export function LicenceNotice({
  businessId,
  businessSlug,
  state,
  template,
  author,
  callerMembershipId,
}: {
  businessId: Id<'businesses'>
  businessSlug: string
  /** The business's state, for what its licences are called. */
  state: string
  template: ReportTemplate
  author: {
    _id: Id<'memberships'>
    name?: string
    licenceNumber?: string
  } | null
  callerMembershipId: Id<'memberships'>
}) {
  // The owner as themselves: switched into someone's account, the Team page
  // is not theirs to open.
  const access = useAccess()
  const viewerIsOwner = access.role === 'owner' && access.actingAs === null
  const fix = licenceFixFor({
    template,
    author,
    callerMembershipId,
    viewerIsOwner,
  })
  if (!fix || !author) return null

  return (
    <div className="px-4 pt-4">
      <div className="rounded-2xl border border-amber-line bg-amber-bg p-3.5">
        <div className="flex items-start gap-2.5">
          <IdCard
            aria-hidden
            size={18}
            strokeWidth={1.9}
            className="mt-0.5 shrink-0 text-orange-ink"
          />
          <div className="min-w-0 flex-1 text-caption text-orange-ink">
            {fix === 'self' ? (
              <>
                <p className="font-semibold">
                  Add your licence number before you finish
                </p>
                <p className="mt-0.5">
                  It prints on this report, and it can’t be finalised without
                  it.
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold">
                  {author.name || 'The author'} has no licence number yet
                </p>
                <p className="mt-0.5">
                  {/* Only the author finalises a certificate, so the fix
                      is theirs to wait on — whoever types the number. */}
                  They can’t finalise this report until it’s added
                  {fix === 'team' ? (
                    <>
                      {' — '}
                      <Link
                        to="/$businessSlug/settings/team/$memberId"
                        params={{ businessSlug, memberId: author._id }}
                        className="font-semibold underline"
                      >
                        add it on their Team page
                      </Link>
                      .
                    </>
                  ) : (
                    '. Ask the owner to add it in Settings → Team.'
                  )}
                </p>
              </>
            )}
          </div>
        </div>
        {fix === 'self' && (
          <OwnLicenceForm
            businessId={businessId}
            membershipId={author._id}
            state={state}
          />
        )}
      </div>
    </div>
  )
}

function OwnLicenceForm({
  businessId,
  membershipId,
  state,
}: {
  businessId: Id<'businesses'>
  membershipId: Id<'memberships'>
  state: string
}) {
  const hydrated = useHydrated()
  const inputId = useId()
  const [value, setValue] = useState('')
  const setLicence = useConvexMutation(api.memberships.setLicence)
  const save = useMutation({
    mutationFn: (licenceNumber: string) =>
      setLicence({ businessId, membershipId, licenceNumber }),
  })

  return (
    <form
      className="mt-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) save.mutate(value)
      }}
    >
      <label
        htmlFor={inputId}
        className="text-caption font-medium text-orange-ink"
      >
        {LICENCE_LABEL[state] ?? 'Licence number'}
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="done"
          maxLength={64}
          className={fieldInputClass('md')}
        />
        <button
          type="submit"
          disabled={!hydrated || save.isPending || !value.trim()}
          className="h-11 shrink-0 rounded-xl bg-red px-4 text-[15px] font-semibold text-white transition active:scale-[.975] disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <FormAlert error={save.isError ? save.error : null} className="mt-2" />
    </form>
  )
}
