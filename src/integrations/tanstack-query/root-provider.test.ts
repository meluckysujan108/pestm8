import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MutationObserver,
  QueryClient,
  onlineManager,
} from '@tanstack/react-query'
import { isOffline } from '#/lib/online'
import { getContext } from './root-provider'

/**
 * A save shaped like the licence pages': it asks the phone first, and says
 * "offline" rather than wait on a socket that is not there.
 */
const checkedSave = () =>
  vi.fn(async () => {
    if (isOffline()) throw new Error('offline')
    return 'saved'
  })

/** The browser's `offline` event: `isOffline()` and react-query both hear it. */
function goOffline() {
  vi.stubGlobal('navigator', { onLine: false })
  onlineManager.setOnline(false)
}

function comeBackOnline() {
  vi.stubGlobal('navigator', { onLine: true })
  onlineManager.setOnline(true)
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

// Mounted as QueryClientProvider mounts the app's: listening for the signal
// to come back, which is when react-query sends what it held.
const mounted: Array<QueryClient> = []
function mount(client: QueryClient) {
  client.mount()
  mounted.push(client)
  return client
}

describe('a save tapped with no signal', () => {
  beforeEach(() => {
    // No socket is opened: without `window` the Convex client stays unbuilt.
    vi.stubEnv('VITE_CONVEX_URL', 'https://happy-otter-123.convex.cloud')
    goOffline()
  })

  afterEach(() => {
    mounted.splice(0).forEach((client) => client.unmount())
    onlineManager.setOnline(true)
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('runs, so its own check says the phone is offline, and is not sent later', async () => {
    const client = mount(getContext().queryClient)
    const mutationFn = checkedSave()
    const save = new MutationObserver(client, { mutationFn })

    const saving = save.mutate()
    expect(
      save.getCurrentResult().isPaused,
      'held until the signal comes back, its check unrun',
    ).toBe(false)
    await expect(saving).rejects.toThrow('offline')

    comeBackOnline()
    await settle()
    expect(mutationFn).toHaveBeenCalledOnce()
  })

  it('is needed: react-query’s default holds the save, then sends it when the signal comes back', async () => {
    const client = mount(new QueryClient())
    const mutationFn = checkedSave()
    const save = new MutationObserver(client, { mutationFn })

    const saving = save.mutate()
    expect(save.getCurrentResult().isPaused).toBe(true)
    // "Saving…", for as long as the phone is out of range.
    await settle()
    expect(mutationFn).not.toHaveBeenCalled()
    expect(save.getCurrentResult().isPending).toBe(true)

    comeBackOnline()
    await expect(saving).resolves.toBe('saved')
    expect(mutationFn).toHaveBeenCalledOnce()
  })
})
