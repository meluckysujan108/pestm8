/**
 * Drafts being replaced by "Start again" right now.
 *
 * The old draft is soft-deleted in the same transaction that creates the new
 * one, and its live query turns null before the mutation's promise resolves
 * with the new id. For that instant the route would render "Not Found" for a
 * page the technician is leaving anyway. The route checks this set and shows
 * nothing instead until the navigation lands.
 */
export const restartingReports = new Set<string>()
