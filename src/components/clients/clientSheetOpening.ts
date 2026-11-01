import { useCallback, useState } from 'react'
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
