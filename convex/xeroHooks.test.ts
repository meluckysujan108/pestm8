// @vitest-environment node
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Release 3 of Xero keeps every connected organisation's copy of the client
 * book up to date, and it learns that something changed in one way only:
 * the write that changed it calls one of the hooks in lib/xeroHooks.ts,
 * which queues the client for each organisation. A write that forgets is a
 * client whose new phone number never reaches Xero — and nothing anywhere
 * would say so: no error, no failed test, just a contact quietly going
 * stale.
 *
 * So this reads the source, as the compiler sees it, and holds every write
 * to the three tables Xero's contacts are made from — `clients`,
 * `clientContacts` and `properties` (a person's address is their oldest
 * site) — to two rules:
 *
 *  1. It names its table: `ctx.db.patch('clients', id, …)`, not
 *     `ctx.db.patch(id, …)`. Then a search finds every write, and so does
 *     this test, without having to work out what an id is.
 *  2. The function it is written in calls a hook (`markClientForXero`,
 *     `markClientsForXero`, `ensureClientInXero` or
 *     `dropXeroLinksForClient`) — or the write says why it needs none, in a
 *     `// xero: exempt — <reason>` comment above it.
 *
 * "The function it is written in" is the nearest named one: a callback
 * written inline (`rows.map((row) => ctx.db.patch(…))`) belongs to the
 * function around it, which is where the hook goes.
 *
 * Not checked: generated code, tests, migrations (one-off repairs that run
 * before or beside a release, by hand), the demo business (it can never
 * connect to Xero), and the Xero modules in lib/ themselves.
 */

const CONVEX = import.meta.dirname

/** The tables a Xero contact is made from. */
const WATCHED = new Set(['clients', 'clientContacts', 'properties'])

const WRITES = new Set(['insert', 'patch', 'replace', 'delete'])

/** lib/xeroHooks.ts — any one of them, called in the writing function. */
const HOOKS = [
  'markClientForXero',
  'markClientsForXero',
  'ensureClientInXero',
  'dropXeroLinksForClient',
] as const

/** A reason is required: an exemption nobody explained is one nobody can
 * check is still true. */
const EXEMPT = /\/\/\s*xero:\s*exempt\s*[—–-]+\s*\S/

type Write = {
  /** `file:line`, from convex/. */
  at: string
  method: string
  /** Every table it may write; empty when the compiler can't tell. */
  tables: Array<string>
  explicit: boolean
  hooked: boolean
  exempt: boolean
}

/** Whether a file under convex/ (path relative to it) is held to the
 * rules. */
function checked(rel: string): boolean {
  return !(
    rel.startsWith('_generated/') ||
    /\.test\.tsx?$/.test(rel) ||
    rel.startsWith('migrations/') ||
    rel.startsWith('demo/') ||
    rel.startsWith('lib/xero') ||
    rel.includes('node_modules/')
  )
}

/** `ctx.db.insert|patch|replace|delete(…)` — or `db.…`, for a `db` taken
 * out of its context — and which of the four. */
function dbWrite(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  if (!WRITES.has(callee.name.text)) return null
  const receiver = callee.expression
  const isDb =
    (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'db') ||
    (ts.isIdentifier(receiver) && receiver.text === 'db')
  return isDb ? callee.name.text : null
}

/** The table names a type stands for: a string literal, a union of them, or
 * a type parameter limited to them. Null when it could be any string. */
function literals(checker: ts.TypeChecker, type: ts.Type): Set<string> | null {
  if (type.isStringLiteral()) return new Set([type.value])
  if (type.isUnion()) {
    const all = new Set<string>()
    for (const part of type.types) {
      const named = literals(checker, part)
      if (!named) return null
      for (const name of named) all.add(name)
    }
    return all
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type)
    if (constraint && constraint !== type) return literals(checker, constraint)
  }
  return null
}

/**
 * The tables a write's first argument names, and whether it names one
 * outright. That argument is either the table's name (`'clients'`) or —
 * the old form — the row's id, whose type `Id<'clients'>` is a string
 * carrying `__tableName: 'clients'`.
 */
function tablesOf(
  checker: ts.TypeChecker,
  arg: ts.Expression | undefined,
): { tables: Set<string>; explicit: boolean } | null {
  if (!arg) return null
  const type = checker.getTypeAtLocation(arg)
  const parts = type.isUnion() ? type.types : [type]
  const tables = new Set<string>()
  let ids = 0
  for (const part of parts) {
    const tag = checker.getPropertyOfType(part, '__tableName')
    const named = tag
      ? literals(checker, checker.getTypeOfSymbolAtLocation(tag, arg))
      : literals(checker, part)
    if (!named) return null
    if (tag) ids += 1
    for (const name of named) tables.add(name)
  }
  return { tables, explicit: ids === 0 }
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

/** The function a write belongs to: the nearest one around it that is not
 * a callback written inline as an argument. */
function ownerOf(node: ts.Node): ts.Node {
  let at = node.parent
  while (!ts.isSourceFile(at)) {
    const parent = at.parent
    const inline =
      ts.isCallExpression(parent) &&
      parent.arguments.some((argument) => argument === at)
    if (isFunction(at) && !inline) return at
    at = parent
  }
  return at
}

/** What to call the owner in a message: `update` for a mutation's handler,
 * `insertClient` for a helper. */
function nameOf(owner: ts.Node): string {
  for (let at = owner; !ts.isSourceFile(at); at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isVariableDeclaration(at)) &&
      at.name &&
      ts.isIdentifier(at.name)
    ) {
      return at.name.text
    }
  }
  return 'the function around it'
}

function callsHook(owner: ts.Node): boolean {
  let found = false
  const visit = (node: ts.Node) => {
    if (found) return
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null
      if (name !== null && (HOOKS as ReadonlyArray<string>).includes(name)) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(owner)
  return found
}

/** A `// xero: exempt — <reason>` above the write, or above any statement
 * it is part of (a loop, an `if`), inside its function. */
function exempted(write: ts.Node, owner: ts.Node, text: string): boolean {
  for (let at = write; at !== owner && !ts.isSourceFile(at); at = at.parent) {
    const comments = ts.getLeadingCommentRanges(text, at.getFullStart()) ?? []
    if (comments.some((c) => EXEMPT.test(text.slice(c.pos, c.end)))) {
      return true
    }
  }
  return false
}

/** Every write in `files`, and what is wrong with the ones on the three
 * tables, as messages naming file:line and what to add. */
function scan(
  program: ts.Program,
  files: ReadonlyArray<{ file: ts.SourceFile; rel: string }>,
): { writes: Array<Write>; problems: Array<string> } {
  const checker = program.getTypeChecker()
  const writes: Array<Write> = []
  const problems: Array<string> = []

  for (const { file, rel } of files) {
    const text = file.getFullText()
    const visit = (node: ts.Node) => {
      const method = dbWrite(node)
      if (method !== null) {
        const call = node as ts.CallExpression
        const { line } = file.getLineAndCharacterOfPosition(call.getStart())
        const at = `${rel}:${line + 1}`
        const named = tablesOf(checker, call.arguments[0])
        const owner = ownerOf(call)
        const write: Write = {
          at,
          method,
          tables: named ? [...named.tables].sort() : [],
          explicit: named?.explicit ?? false,
          hooked: callsHook(owner),
          exempt: exempted(call, owner, text),
        }
        writes.push(write)

        const shown = `ctx.db.${method}`
        if (!named) {
          problems.push(
            `${at} — ${shown}(…) on a table the compiler can't name: pass a ` +
              `table name or a typed Id, so it can be checked for a Xero hook.`,
          )
        } else if (write.tables.some((t) => WATCHED.has(t))) {
          const table = write.tables.filter((t) => WATCHED.has(t)).join('|')
          if (!write.explicit) {
            const rest = method === 'delete' ? 'id' : 'id, …'
            problems.push(
              write.tables.length > 1
                ? `${at} — ${shown}(${rest}) on ${table}: split it, so each ` +
                    `write names its own table — ${shown}('${write.tables[0]}', ${rest}).`
                : `${at} — ${shown}(${rest}) on ${table}: name the table, ` +
                    `${shown}('${write.tables[0]}', ${rest}).`,
            )
          }
          if (!write.hooked && !write.exempt) {
            const where = nameOf(owner)
            problems.push(
              `${at} — ${shown} on ${table} with no Xero hook: call ` +
                `${HOOKS.join(', ')} (convex/lib/xeroHooks.ts) in ${where}, ` +
                `or put "// xero: exempt — <why>" above the write.`,
            )
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return { writes, problems }
}

/** The Convex functions, as `npx convex` and `tsc -p convex` see them. */
function convexProgram(): ts.Program {
  const configPath = resolve(CONVEX, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path))
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    )
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, CONVEX)
  return ts.createProgram(parsed.fileNames, parsed.options)
}

function projectFiles(program: ts.Program) {
  return program
    .getSourceFiles()
    .map((file) => ({
      file,
      rel: relative(CONVEX, file.fileName).split('\\').join('/'),
    }))
    .filter(({ rel }) => !rel.startsWith('..') && checked(rel))
}

describe('every write to a client, contact or site reaches Xero', () => {
  it('names its table, and calls a Xero hook or says why it needs none', () => {
    const program = convexProgram()
    const { writes, problems } = scan(program, projectFiles(program))

    // The check is only as good as what it finds: a resolver that quietly
    // named nothing would pass everything. Every one of these writes to
    // the three tables today.
    const seen = (table: string) =>
      new Set(
        writes
          .filter((w) => w.tables.includes(table))
          .map((w) => w.at.split(':')[0]),
      )
    expect([...seen('clients')]).toEqual(
      expect.arrayContaining([
        'clients.ts',
        'properties.ts',
        'bin.ts',
        'clientImports.ts',
      ]),
    )
    expect([...seen('clientContacts')]).toEqual(
      expect.arrayContaining([
        'clientContacts.ts',
        'properties.ts',
        'bin.ts',
        'clientImports.ts',
      ]),
    )
    expect([...seen('properties')]).toEqual(
      expect.arrayContaining(['properties.ts', 'bin.ts', 'clientImports.ts']),
    )

    expect(problems, `\n${problems.join('\n')}\n`).toEqual([])
  }, 60_000)
})

describe('the check itself', () => {
  /** Enough of Convex's shapes to check a few lines of source against. */
  const PRELUDE = `
    type Id<T extends string> = string & { __tableName: T }
    declare const ctx: {
      db: {
        insert(...args: Array<unknown>): Promise<unknown>
        patch(...args: Array<unknown>): Promise<void>
        replace(...args: Array<unknown>): Promise<void>
        delete(...args: Array<unknown>): Promise<void>
      }
    }
    declare function markClientForXero(ctx: unknown, id: Id<'clients'>): Promise<void>
    declare const clientId: Id<'clients'>
    declare const siteId: Id<'properties'>
    declare const jobId: Id<'jobs'>
    declare const someId: string
    export {}
  `

  const SOURCES: Partial<Record<string, string>> = {
    'unhooked.ts': `
      export async function rename() {
        await ctx.db.patch('clients', clientId, { name: 'Jan' })
      }`,
    'implicit.ts': `
      export async function rename() {
        await ctx.db.patch(clientId, { name: 'Jan' })
        await markClientForXero(ctx, clientId)
      }`,
    'hooked.ts': `
      export async function rename() {
        await ctx.db.patch('clients', clientId, { name: 'Jan' })
        await Promise.all([siteId].map((id) => ctx.db.delete('properties', id)))
        await markClientForXero(ctx, clientId)
      }`,
    'exempt.ts': `
      export async function tidy() {
        // xero: exempt — only clears the import's mark; Xero gets nothing new
        await ctx.db.patch('clients', clientId, { importId: undefined })
        // xero: exempt — the client goes next, and its links with it
        for (const id of [siteId]) await ctx.db.delete('properties', id)
      }`,
    'reasonless.ts': `
      export async function tidy() {
        // xero: exempt
        await ctx.db.patch('clients', clientId, { importId: undefined })
      }`,
    'elsewhere.ts': `
      export async function rename() {
        await ctx.db.patch('clients', clientId, { name: 'Jan' })
      }
      export async function other() {
        await markClientForXero(ctx, clientId)
      }`,
    'other-tables.ts': `
      export async function untouched() {
        await ctx.db.patch(jobId, { status: 'done' })
        await ctx.db.insert('jobs', {})
      }`,
    'unnamed.ts': `
      export async function guess() {
        await ctx.db.delete(someId as any)
      }`,
  }

  function synthetic() {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noEmit: true,
    }
    const host = ts.createCompilerHost(options)
    const real = host.getSourceFile.bind(host)
    const source = (name: string) => {
      const body = SOURCES[name.split('/').pop() ?? '']
      return body === undefined ? undefined : PRELUDE + body
    }
    host.getSourceFile = (name, version, ...rest) => {
      const text = source(name)
      return text === undefined
        ? real(name, version, ...rest)
        : ts.createSourceFile(name, text, version)
    }
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (name) => source(name) !== undefined || fileExists(name)
    const roots = Object.keys(SOURCES).map((name) => `/virtual/${name}`)
    const program = ts.createProgram(roots, options, host)
    return (name: string) =>
      scan(program, [
        { file: program.getSourceFile(`/virtual/${name}`)!, rel: name },
      ])
  }
  const check = synthetic()

  it('flags a write to a client with no hook, naming file:line', () => {
    const { problems } = check('unhooked.ts')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^unhooked\.ts:\d+ — ctx\.db\.patch on clients/)
    expect(problems[0]).toContain('markClientForXero')
    expect(problems[0]).toContain('in rename')
  })

  it('flags a write that leaves the table to its id', () => {
    const { problems } = check('implicit.ts')
    expect(problems).toEqual([
      expect.stringMatching(
        /^implicit\.ts:\d+ — ctx\.db\.patch\(id, …\) on clients: name the table/,
      ),
    ])
  })

  it('passes a hooked write, inline callbacks included', () => {
    expect(check('hooked.ts').problems).toEqual([])
  })

  it('passes a write that says why it needs no hook', () => {
    expect(check('exempt.ts').problems).toEqual([])
  })

  it('wants a reason with the exemption', () => {
    expect(check('reasonless.ts').problems).toHaveLength(1)
  })

  it('wants the hook in the writing function, not just the same file', () => {
    expect(check('elsewhere.ts').problems).toHaveLength(1)
  })

  it('leaves the other tables alone', () => {
    const { writes, problems } = check('other-tables.ts')
    expect(writes.map((w) => w.tables)).toEqual([['jobs'], ['jobs']])
    expect(problems).toEqual([])
  })

  it('flags a write whose table the compiler cannot name', () => {
    const { problems } = check('unnamed.ts')
    expect(problems).toEqual([
      expect.stringContaining("on a table the compiler can't name"),
    ])
  })
}, 60_000)
