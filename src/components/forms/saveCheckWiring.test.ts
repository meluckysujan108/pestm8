// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, test } from 'vitest'

/**
 * A form's own check, made in the component that renders its
 * SaveWarningsProvider, finds no provider above it: a component reads only
 * the context of those above it. So it must be given that form's
 * controller (`useSaveCheck`'s last argument), or it is never asked and
 * Save goes straight through, as New Job's, New client's and Add
 * property's match checks did until e2e found it (matching M3, 1 Nov 2026).
 * There is no DOM renderer in these tests to press Book, so this pins it in
 * every component under src.
 */
const SRC = resolve(import.meta.dirname, '../..')

function sources(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)
      ? [path]
      : []
  })
}

/** Each top-level function in `text`: its name and its text. */
function functions(text: string): Array<[string, string]> {
  const starts = [
    ...text.matchAll(/^(?:export (?:default )?)?function (\w+)\(/gm),
  ]
  return starts.map((start, i) => [
    start[1],
    text.slice(start.index, starts[i + 1]?.index ?? text.length),
  ])
}

/**
 * The arguments of each call of `useSaveCheck` in `text`, as written, up to
 * its closing parenthesis: strings and comments skipped, so a bracket in
 * one isn't counted.
 */
function saveCheckCalls(text: string): Array<string> {
  const calls: Array<string> = []
  for (const call of text.matchAll(/\buseSaveCheck\(/g)) {
    const from = call.index + call[0].length
    let depth = 1
    let i = from
    while (i < text.length && depth > 0) {
      const c = text[i]
      if (c === '/' && text[i + 1] === '/') {
        i = text.indexOf('\n', i)
        if (i === -1) break
      } else if (c === '/' && text[i + 1] === '*') {
        i = text.indexOf('*/', i) + 1
      } else if (c === "'" || c === '"' || c === '`') {
        i += 1
        while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1
      } else if (c === '(' || c === '[' || c === '{') depth += 1
      else if (c === ')' || c === ']' || c === '}') depth -= 1
      i += 1
    }
    calls.push(text.slice(from, i - 1))
  }
  return calls
}

/** The last argument of a call's arguments, as written. */
function lastArgument(args: string): string {
  const lines = args
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line !== '')
  return (
    (lines.at(-1) ?? '')
      .replace(/,$/, '')
      .split(/[\s,]+/)
      .at(-1) ?? ''
  )
}

test('a component that renders the save-warnings provider gives its own checks that controller', () => {
  const checked: Array<string> = []
  for (const file of sources(SRC)) {
    for (const [name, body] of functions(readFileSync(file, 'utf8'))) {
      const provider = /<SaveWarningsProvider value=\{(\w+)\}>/.exec(body)
      if (!provider) continue
      for (const args of saveCheckCalls(body)) {
        const where = `${relative(SRC, file)} ${name}`
        checked.push(where)
        expect(lastArgument(args), where).toBe(provider[1])
      }
    }
  }
  // Those there are as this is written, so a scan that finds none fails.
  expect(checked).toEqual(
    expect.arrayContaining([
      'components/schedule/NewJobSheet.tsx NewJobForm',
      'components/clients/NewPropertySheet.tsx NewPropertySheet',
      'components/clients/ClientSheet.tsx NewPropertyForClientForm',
    ]),
  )
})
