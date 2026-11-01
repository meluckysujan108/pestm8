import { useCallback, useEffect, useState } from 'react'
import type { SiteAddressDraft } from './NewClientFields'

/**
 * How a client's sheet opens when Clients → New client found the caller to
 * be this client already (the matching plan's §2.10): on Details, where
 * their sites are, with Add property open on the address the caller gave
 * (`addSite`) when it isn't one of theirs. When it is, Details shows it among
 * their sites, and nothing is added.
 */
export type OpenedFromNewClient = { addSite?: SiteAddressDraft }

/** The client sheet's three parts. */
export type ClientTab = 'jobs' | 'notes' | 'details'

/** The part a client's sheet opens on: their jobs, unless New client
 * opened it, when it is Details whether or not anything is to be added. */
export function firstTab(opened: OpenedFromNewClient | undefined): ClientTab {
  return opened ? 'details' : 'jobs'
}

/**
 * The address New client opened the sheet with, for Add property once: the
 * first Details drawn opens on it and takes it (`taken`), so going to Jobs
 * and back, or booking from the sheet, doesn't open Add property on it
 * again, though the opener still holds it until the sheet closes.
 */
export function useAddSiteOnce(addSite: SiteAddressDraft | undefined): {
  addSite: SiteAddressDraft | undefined
  taken: () => void
} {
  const [left, setLeft] = useState(addSite)
  const taken = useCallback(() => setLeft(undefined), [])
  return { addSite: left, taken }
}

/** About as long as a sheet takes to slide up, so what is brought into
 * view after it is brought to where the sheet stops. */
export const SHEET_RISE_MS = 350

/**
 * Add property opened on the address New client gave is at the foot of
 * Details, under their details and sites, and below the fold on a phone:
 * brought into view once the sheet has slid up (`opened`, as it mounts), so
 * the caller's address is what the person sees, as an import's first thing
 * to put right is. Not focused: on a phone the keyboard would rise over the
 * sheet before it is read.
 */
export function useIntoViewOnOpen(
  form: { readonly current: Pick<Element, 'scrollIntoView'> | null },
  opened: boolean,
): void {
  const [bring] = useState(opened)
  useEffect(() => {
    if (!bring) return
    const timer = setTimeout(() => {
      form.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, SHEET_RISE_MS)
    return () => clearTimeout(timer)
  }, [bring, form])
}
