/**
 * Reports this tab is leaving right now, because they are going away.
 *
 * "Start again" soft-deletes the old draft in the same transaction that
 * creates the new one, and deleting a finalised report from its own page
 * takes it out of Reports; either way the report's live query turns null
 * before the mutation's promise resolves and the page navigates. For that
 * instant the route would render "Not Found" for a page the person is
 * leaving anyway. The route checks this set and shows nothing instead until
 * the navigation lands.
 */
export const leavingReports = new Set<string>()
