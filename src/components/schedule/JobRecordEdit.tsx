import { useEffect, useLayoutEffect } from 'react'
import { useRouteContext } from '@tanstack/react-router'
import { ClientEditForm } from '#/components/clients/ClientEditForm'
import { PropertyEditMode } from '#/components/clients/PropertyEditMode'
import { useCan } from '#/lib/access'
import { loadLocalities } from '#/lib/addressVerify'
import type { ReactNode, RefObject } from 'react'
import type { Doc, Id } from '../../../convex/_generated/dataModel'

/**
 * A job's client or property, edited from the job sheet (Edit → Client
 * details, Property details): the client sheet's own forms, in the job
 * sheet. Loaded only when the job opens, never with the Schedule, so the
 * forms and their checks stay out of the page a technician opens most.
 */

/** The record as it was when its row was chosen, not as it is now: the
 * save goes to the client or site chosen even if the job is moved
 * meanwhile, and a field left alone isn't sent back over the office's. */
export type RecordEditTarget =
  | { what: 'client'; client: Doc<'clients'>; contactPerson: string }
  | {
      what: 'property'
      property: Doc<'properties'>
      clientKind: Doc<'clients'>['kind']
    }

export function JobRecordEdit({
  businessId,
  target,
  header,
  titleRef,
  focusTitle,
  onDone,
}: {
  businessId: Id<'businesses'>
  target: RecordEditTarget
  /** The sheet's heading, built by the job sheet so its loading and its
   * could-not-load states carry it too. */
  header: ReactNode
  /** The heading's title, which `header` holds. */
  titleRef: RefObject<HTMLHeadingElement | null>
  /** Chosen in the Edit sheet: focus goes to the title. */
  focusTitle?: boolean
  onDone: () => void
}) {
  const businessState = useRouteContext({
    from: '/$businessSlug',
    select: (context) => context.business.state,
  })
  const canRenumber = useCan('business.manage')

  // The state's suburb table, fetched as the form opens while there is
  // signal, so an address edited at a door with none is still checked.
  useEffect(() => {
    void loadLocalities(businessState)
  }, [businessState])

  // Normally the Edit sheet puts focus on the title as it finishes closing.
  // When this arrives after that, in place of the loading state's title,
  // focus went with that element: it is put on this one instead, unless the
  // person has already moved it somewhere.
  useLayoutEffect(() => {
    if (!focusTitle) return
    const active = document.activeElement
    if (
      active === null ||
      active === document.body ||
      active.getAttribute('role') === 'dialog'
    ) {
      titleRef.current?.focus()
    }
    // On arrival only.
  }, [])

  if (target.what === 'client') {
    return (
      <ClientEditForm
        businessId={businessId}
        businessState={businessState}
        client={target.client}
        contactPerson={target.contactPerson}
        canRenumber={canRenumber}
        onDone={onDone}
        header={header}
      />
    )
  }
  return (
    <PropertyEditMode
      businessId={businessId}
      businessState={businessState}
      clientKind={target.clientKind}
      property={target.property}
      header={header}
      onDone={onDone}
    />
  )
}
