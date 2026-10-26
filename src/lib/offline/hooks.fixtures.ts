/**
 * Just enough of React's hooks to run one hook outside a document, for
 * tests of what a hook does over time: its effects, its timers, what it
 * subscribes to. The tests here run without a DOM (vitest.config.ts), where
 * React itself can render to a string and run nothing after.
 *
 * A test mocks `react` with these in place of the real hooks:
 *
 *   vi.mock('react', async (importOriginal) => ({
 *     ...(await importOriginal<typeof React>()),
 *     ...(await import('./hooks.fixtures')).hookHarness.hooks,
 *   }))
 *
 * and mounts the hook under test (`hookHarness.mount`). As React does, it
 * renders again at once for an update made while rendering, runs effects
 * after each render that settles (cleaning up the last first, where their
 * dependencies changed), and renders again for an update made after, at once
 * as `act` would. Layout effects run as effects do. A mount `hydrating`
 * renders first with each store's server snapshot, as hydration does, then
 * again with the browser's.
 */

type Deps = ReadonlyArray<unknown> | undefined

type EffectSlot = {
  ran: boolean
  deps: Deps
  cleanup: (() => void) | undefined
}
type StoreSlot = {
  subscribe: ((listener: () => void) => () => void) | null
  unsubscribe: (() => void) | undefined
  getSnapshot: () => unknown
  value: unknown
}

function changed(before: Deps, after: Deps): boolean {
  if (before === undefined || after === undefined) return true
  return (
    before.length !== after.length ||
    before.some((each, i) => !Object.is(each, after[i]))
  )
}

class HookHarness {
  private slots: Array<unknown> = []
  private index = 0
  private phase: 'idle' | 'rendering' | 'committing' = 'idle'
  private dirty = false
  private effects: Array<() => void> = []
  private hook: (() => unknown) | null = null
  private result: unknown
  private hydrating = false
  /** How many renders have run since the mount, render-phase ones included. */
  renders = 0

  /** Mounts `hook` alone, as a component calling only it would. */
  mount<T>(
    hook: () => T,
    { hydrating = false }: { hydrating?: boolean } = {},
  ): { current: () => T; rerender: () => void; unmount: () => void } {
    this.unmount()
    this.slots = []
    this.renders = 0
    this.hook = hook
    this.hydrating = hydrating
    this.run()
    if (hydrating) {
      this.hydrating = false
      this.run()
    }
    return {
      current: () => this.result as T,
      rerender: () => this.run(),
      unmount: () => this.unmount(),
    }
  }

  private unmount(): void {
    for (const slot of this.slots) {
      if (slot && typeof slot === 'object' && 'cleanup' in slot) {
        ;(slot as EffectSlot).cleanup?.()
      }
      if (slot && typeof slot === 'object' && 'unsubscribe' in slot) {
        ;(slot as StoreSlot).unsubscribe?.()
      }
    }
    this.slots = []
    this.hook = null
  }

  private run(): void {
    if (!this.hook) return
    for (let pass = 0; ; pass++) {
      if (pass > 50) throw new Error('Too many re-renders')
      this.phase = 'rendering'
      this.dirty = false
      this.index = 0
      this.effects = []
      this.renders++
      this.result = this.hook()
      if (this.updated()) continue
      this.phase = 'committing'
      for (const effect of this.effects) effect()
      this.phase = 'idle'
      if (!this.updated()) return
    }
  }

  /** Whether an update came while rendering or committing (`schedule`). */
  private updated(): boolean {
    return this.dirty
  }

  private schedule(): void {
    if (this.phase === 'idle') this.run()
    else this.dirty = true
  }

  private slot<TSlot>(init: () => TSlot): TSlot {
    const at = this.index++
    if (at >= this.slots.length) this.slots.push(init())
    return this.slots[at] as TSlot
  }

  private useReducerImpl<TState, TAction>(
    reducer: (state: TState, action: TAction) => TState,
    initial: () => TState,
  ): [TState, (action: TAction) => void] {
    const slot = this.slot(() => {
      const box = { value: initial(), dispatch: (_action: TAction) => {} }
      box.dispatch = (action: TAction) => {
        const next = reducer(box.value, action)
        if (Object.is(next, box.value)) return
        box.value = next
        this.schedule()
      }
      return box
    })
    return [slot.value, slot.dispatch]
  }

  private useEffectImpl(effect: () => void | (() => void), deps?: Deps): void {
    const slot = this.slot<EffectSlot>(() => ({
      ran: false,
      deps: undefined,
      cleanup: undefined,
    }))
    // Its dependencies are taken as it runs, not as it renders: a render
    // thrown away for an update made in it changes nothing.
    if (slot.ran && !changed(slot.deps, deps)) return
    this.effects.push(() => {
      slot.cleanup?.()
      slot.ran = true
      slot.deps = deps
      const cleanup = effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    })
  }

  private memo<T>(make: () => T, deps: Deps): T {
    const slot = this.slot<{ deps: Deps; value: T | undefined }>(() => ({
      deps: undefined,
      value: undefined,
    }))
    if (slot.deps === undefined || changed(slot.deps, deps)) {
      slot.value = make()
      slot.deps = deps
    }
    return slot.value as T
  }

  private useSyncExternalStoreImpl<T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T {
    const slot = this.slot<StoreSlot>(() => ({
      subscribe: null,
      unsubscribe: undefined,
      getSnapshot,
      value: undefined,
    }))
    slot.getSnapshot = getSnapshot
    const value =
      this.hydrating && getServerSnapshot ? getServerSnapshot() : getSnapshot()
    slot.value = value
    if (slot.subscribe !== subscribe) {
      this.effects.push(() => {
        slot.unsubscribe?.()
        slot.subscribe = subscribe
        const check = () => {
          if (!Object.is(slot.getSnapshot(), slot.value)) this.schedule()
        }
        slot.unsubscribe = subscribe(check)
        // Anything that changed between the render and the subscription.
        check()
      })
    }
    return value
  }

  /** The hooks, for the mock of `react`. */
  readonly hooks = {
    useState: <TState>(initial: TState | (() => TState)) =>
      this.useReducerImpl<TState, TState | ((before: TState) => TState)>(
        (before, next) =>
          typeof next === 'function'
            ? (next as (before: TState) => TState)(before)
            : next,
        () =>
          typeof initial === 'function' ? (initial as () => TState)() : initial,
      ),
    useReducer: <TState, TAction>(
      reducer: (state: TState, action: TAction) => TState,
      initial: TState,
    ) => this.useReducerImpl(reducer, () => initial),
    useEffect: (effect: () => void | (() => void), deps?: Deps) =>
      this.useEffectImpl(effect, deps),
    useLayoutEffect: (effect: () => void | (() => void), deps?: Deps) =>
      this.useEffectImpl(effect, deps),
    useRef: <T>(initial: T) => this.slot(() => ({ current: initial })),
    useCallback: <T>(callback: T, deps: Deps) =>
      this.memo(() => callback, deps),
    useMemo: <T>(make: () => T, deps: Deps) => this.memo(make, deps),
    useSyncExternalStore: <T>(
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ) =>
      this.useSyncExternalStoreImpl(subscribe, getSnapshot, getServerSnapshot),
  }
}

/** The one harness a test file's mock of `react` and its tests share. */
export const hookHarness = new HookHarness()
