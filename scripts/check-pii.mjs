/**
 * Refuses to let the source forms' real client details into the repo.
 *
 * The Pest M8 forms this feature reproduces were supplied as a real
 * submission: a real client, their real email, their real address, the GPS of
 * their house. `scripts/extract-form-strings.mjs` strips those before anything
 * is committed, using the pattern list in `scripts/form-redactions.local`,
 * which is gitignored precisely because it *contains* them.
 *
 * Stripping once is not enough. A name that was in front of you while you
 * wrote a fixture ends up in the fixture — which is exactly what happened:
 * the client's real name sat in two committed test files for several weeks,
 * having been typed in by hand rather than copied from a source file. So this
 * checks the whole tracked tree, every time, rather than trusting the one-time
 * extraction.
 *
 *   node scripts/check-pii.mjs
 *
 * Exits non-zero, naming the file and line, if any redaction pattern matches a
 * tracked file. Without the local pattern list it exits 0 with a notice: a
 * machine that never had the source cannot leak it, and failing the build on
 * a missing gitignored file would only teach people to skip the check.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const LIST = 'scripts/form-redactions.local'

if (!existsSync(LIST)) {
  console.log(`${LIST} is not here — nothing to check against. Skipping.`)
  process.exit(0)
}

const patterns = JSON.parse(readFileSync(LIST, 'utf8'))
  .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
  .filter((p) => typeof p === 'string' && p.length > 0)
  .map((p) => new RegExp(p, 'i'))

const SKIP = /\.(png|jpe?g|gif|webp|zip|pdf|ico|woff2?|ttf)$/i
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !SKIP.test(f) && f !== LIST)

const found = []
for (const file of files) {
  let body
  try {
    body = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  body.split('\n').forEach((line, i) => {
    // The index, never the matched text: this output goes to a terminal, a CI
    // log and a screenshot, and printing the thing we are protecting would
    // defeat the exercise.
    const hit = patterns.findIndex((p) => p.test(line))
    if (hit !== -1) found.push(`${file}:${i + 1}  (redaction pattern #${hit})`)
  })
}

if (found.length > 0) {
  console.error("Real client details from the source forms are in tracked files:\n")
  for (const f of found) console.error(`  ${f}`)
  console.error(
    `\n${found.length} occurrence(s). Replace them with a fixture — this repo uses` +
      ' "J. Nguyen" and example.com addresses everywhere else.',
  )
  process.exit(1)
}

console.log(`No source-form client details in ${files.length} tracked files.`)
