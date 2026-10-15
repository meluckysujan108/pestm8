import './harness.css'
import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConvexProvider } from 'convex/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { getFunctionName } from 'convex/server'
import { resolveFixture, resolveLiveFixture, resolveMutation } from './fixtures'
import { SPECIMENS } from './specimens'

const params = new URLSearchParams(location.search)
const name = params.get('s') ?? 'index'
const theme = params.get('theme') ?? 'light'
const path = params.get('path') ?? '/demo/schedule'
document.documentElement.dataset.theme = theme
if (params.get('debug')) {
  const style = document.createElement('style')
  style.textContent =
    '.tap-target::after{outline:1.5px dashed #d0f;outline-offset:-1px}'
  document.head.appendChild(style)
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: Infinity,
      queryFn: async ({ queryKey }) => {
        const [, fn, args] = queryKey as [string, string, unknown]
        const value = resolveFixture(fn, args)
        if (value === undefined) {
          console.warn('[harness] no fixture for', fn, JSON.stringify(args))
          return new Promise(() => {})
        }
        return value
      },
    },
  },
})

// Stands in for ConvexReactClient: mutations resolve to null (or as
// `resolveMutation` says), nothing connects, and only the queries the
// fixtures list as live answer through it (`resolveLiveFixture`).
const nameOf = (fn: unknown) =>
  typeof fn === 'string' ? fn : getFunctionName(fn as never)
const fakeConvex = {
  mutation: async (fn: unknown, args: unknown) =>
    resolveMutation(nameOf(fn), args),
  action: async () => null,
  query: async () => null,
  watchQuery: (fn: unknown, args: unknown) => ({
    onUpdate: () => () => {},
    localQueryResult: () => resolveLiveFixture(nameOf(fn), args),
    journal: () => undefined,
  }),
  setAuth: () => {},
  clearAuth: () => {},
  connectionState: () => ({ isWebSocketConnected: false }),
} as never

function Specimen() {
  const Comp = SPECIMENS[name]
  if (!Comp)
    return (
      <ul className="p-4">
        {Object.keys(SPECIMENS).map((k) => (
          <li key={k}>
            <a className="text-blue" href={`?s=${k}`}>
              {k}
            </a>
          </li>
        ))}
      </ul>
    )
  return (
    <Suspense fallback={<p className="p-4">suspended…</p>}>
      <Comp />
    </Suspense>
  )
}

const rootRoute = createRootRoute({ component: Specimen })
const splat = createRoute({ getParentRoute: () => rootRoute, path: '$' })
const router = createRouter({
  routeTree: rootRoute.addChildren([splat]),
  history: createMemoryHistory({ initialEntries: [path] }),
})

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <ConvexProvider client={fakeConvex}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ConvexProvider>
  </StrictMode>,
)
