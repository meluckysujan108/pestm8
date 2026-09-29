import type { RootState } from '#/lib/rootState'

/**
 * What vite.config.ts serves in place of src/lib/initialState.ts.
 *
 * The real one is a TanStack Start server function: it reads the session
 * token through `#/lib/auth-server` and the theme cookie through
 * `@tanstack/react-start/server`, which only the Start plugin can resolve, and
 * the harness runs without that plugin. The licence specimens reach it all the
 * same, through keptLicence.ts and rootState.ts. Nobody is signed in to the
 * harness, and that is what this answers.
 */
export const getInitialState = async (): Promise<RootState> => ({
  token: undefined,
  theme: 'system',
})
