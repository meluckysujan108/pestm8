import { ConvexQueryClient } from '@convex-dev/react-query'
import { keeper } from './keeper'
import type { ConvexReactClient } from 'convex/react'
import type { ConvexQueryClientOptions } from '@convex-dev/react-query'

/** Who hears each push: the page load's keeper, or a test's. */
type Hears = { heard: (queryHash: string, pushed: boolean) => void }

/**
 * The react-query adapter, telling the keeper (keeper.ts) of every answer
 * the server pushes.
 *
 * The adapter watches each Convex query in the cache over the socket from
 * the moment its entry is added, and every answer the server pushes for it,
 * the first included, goes through `onUpdateQueryKeyHash` (index.js:86 and
 * :160 in @convex-dev/react-query 0.1.0). That push is the one sure sign an
 * answer is the server's on the connection the socket has now: what makes a
 * kept answer live, and fit to be written to the phone.
 *
 * Whether the push set anything is read off the entry's `dataUpdateCount`,
 * not its data. The adapter sets nothing on an entry that has none yet (its
 * own fetch is still out), and react-query keeps the old data object when a
 * push brings an equal one, so a comparison of the data would miss a push
 * that confirmed an answer without changing it.
 */
export class KeepingConvexQueryClient extends ConvexQueryClient {
  constructor(
    client: ConvexReactClient,
    options?: ConvexQueryClientOptions,
    private readonly hears: Hears = keeper,
  ) {
    super(client, options)
  }

  override onUpdateQueryKeyHash(queryHash: string): void {
    const before = this._queryClient?.getQueryCache().get(queryHash)
      ?.state.dataUpdateCount
    super.onUpdateQueryKeyHash(queryHash)
    const after = this._queryClient?.getQueryCache().get(queryHash)
      ?.state.dataUpdateCount
    this.hears.heard(queryHash, after !== undefined && after !== before)
  }
}
