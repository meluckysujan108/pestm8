/**
 * Proves the built service worker is actually *served*, not just written.
 *
 * ARCHITECTURE.md §5.5 already fails the build when sw.js is missing or empty
 * (see scripts/build-sw.ts). That gate passed while a local production run
 * answered `/sw.js` with a 307 to /login, because the file existed on disk but
 * was absent from Nitro's static-asset manifest. So for a node-server build
 * this boots the real server and requests the worker the way a browser would.
 *
 * A Vercel-preset build has no local server to boot; Vercel serves
 * `.vercel/output/static` from the filesystem, so the file being there is
 * what "reachable" means.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

class CheckFailed extends Error {}
const fail = (message) => {
  throw new CheckFailed(message)
}

const NODE_SERVER = resolve('.output/server/index.mjs')
const NODE_SW = resolve('.output/public/sw.js')
const VERCEL_SW = resolve('.vercel/output/static/sw.js')
const VERCEL_CONFIG = resolve('.vercel/output/config.json')

// Each preset only clears its own output dir, so a stale build of the other
// can be lying around; check whichever one this build just wrote.
const mtime = (path) => (existsSync(path) ? statSync(path).mtimeMs : -1)
const builtForVercel = mtime(VERCEL_CONFIG) > mtime(NODE_SERVER)

async function main() {
  if (builtForVercel) {
    if (existsSync(VERCEL_SW) && statSync(VERCEL_SW).size > 0) {
      console.log(
        `✓ Service worker present at ${VERCEL_SW} (served from the filesystem by Vercel)`,
      )
      return
    }
    fail(`Service worker missing or empty at ${VERCEL_SW}`)
  }

  if (!existsSync(NODE_SERVER)) fail(`No production build at ${NODE_SERVER}.`)

  if (!existsSync(NODE_SW) || statSync(NODE_SW).size === 0) {
    fail(`Service worker missing or empty at ${NODE_SW}`)
  }

  const port = await new Promise((done, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })

  const server = spawn(process.execPath, [NODE_SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  server.stderr.on('data', (chunk) => (stderr += chunk))
  const exited = new Promise((done) => server.once('exit', done))

  try {
    const url = `http://127.0.0.1:${port}/sw.js`
    let response
    for (let attempt = 0; attempt < 100 && !response; attempt++) {
      if (server.exitCode !== null) {
        fail(`The production server exited before serving ${url}:\n${stderr}`)
      }
      // `manual` so a redirect to /login shows up as the failure it is rather
      // than being followed to a 200 HTML page.
      response = await fetch(url, { redirect: 'manual' }).catch(() => undefined)
      if (!response) await new Promise((done) => setTimeout(done, 100))
    }
    if (!response)
      fail(`The production server never answered ${url}:\n${stderr}`)

    const type = response.headers.get('content-type') ?? ''
    const body = Buffer.from(await response.arrayBuffer())
    if (response.status !== 200) {
      const location = response.headers.get('location')
      fail(
        `GET /sw.js returned ${response.status}${location ? ` → ${location}` : ''} from the local production server, so the app runs with no service worker. Is sw.js in Nitro's public-asset manifest?`,
      )
    }
    if (!type.includes('javascript')) {
      fail(
        `GET /sw.js returned content-type "${type}", which browsers refuse to register as a worker.`,
      )
    }
    if (!body.equals(readFileSync(NODE_SW))) {
      fail(`GET /sw.js served something other than ${NODE_SW}.`)
    }
    console.log(
      `✓ Service worker served by the local production server at /sw.js (${type})`,
    )
  } finally {
    server.kill()
    await exited
  }
}

await main().catch((error) => {
  console.error(
    `\n✖ ${error instanceof CheckFailed ? error.message : error.stack}`,
  )
  process.exitCode = 1
})
