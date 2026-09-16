/**
 * Renders a PDF's pages to PNGs. Scratchpad tooling only — the source document
 * carries a real client's details, which must never enter the repo.
 *
 * pdfjs needs a canvas and this repo deliberately has no native `canvas`
 * dependency, so Playwright's chromium is the canvas. Everything is served over
 * a throwaway HTTP server because module imports from file:// are blocked.
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const [, , source, out] = process.argv
mkdirSync(out, { recursive: true })

const root = '/Users/sujanneupane/pestm8/node_modules/pdfjs-dist/build'
const files = {
  '/pdf.mjs': [readFileSync(`${root}/pdf.min.mjs`), 'text/javascript'],
  '/pdf.worker.mjs': [readFileSync(`${root}/pdf.worker.min.mjs`), 'text/javascript'],
  '/doc.pdf': [readFileSync(source), 'application/pdf'],
  '/': [
    Buffer.from(`<!doctype html><body style="margin:0"><script type="module">
      import * as lib from './pdf.mjs'
      lib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs'
      window.render = async (n, scale) => {
        window.doc ??= await lib.getDocument('./doc.pdf').promise
        const page = await window.doc.getPage(n)
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise
        return canvas.toDataURL('image/png')
      }
      window.pages = async () => (window.doc ??= await lib.getDocument('./doc.pdf').promise).numPages
      window.ready = true
    </script></body>`),
    'text/html',
  ],
}

const server = createServer((req, res) => {
  const [body, type] = files[req.url.split('?')[0]] ?? [Buffer.from('no'), 'text/plain']
  res.writeHead(200, { 'Content-Type': type })
  res.end(body)
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(base)
await page.waitForFunction('window.ready === true')
const count = await page.evaluate(() => window.pages())
for (let n = 1; n <= count; n++) {
  const url = await page.evaluate(([n, s]) => window.render(n, s), [n, 1.5])
  writeFileSync(`${out}/page-${String(n).padStart(2, '0')}.png`, Buffer.from(url.split(',')[1], 'base64'))
  console.log('rendered page', n)
}
await browser.close()
server.close()
