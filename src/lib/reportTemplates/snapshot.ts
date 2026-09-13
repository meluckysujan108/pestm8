import { sectionsOf } from './index'
import type {
  PrintSpec,
  ReportTemplate,
  RichDoc,
  SectionDef,
  TemplateId,
} from './types'

/**
 * The frozen wording a finalised report renders from.
 *
 * Everything a painter needs and nothing it does not: no Zod schema (it is a
 * live `z.ZodType` and cannot cross the wire — see `resolveReportTemplate`),
 * no Convex bookkeeping, no `fields`. `sections` is always the normalised
 * shape, so a template that declares a flat `fields` list and one that
 * declares sections freeze identically.
 */
export type TemplateSnapshotContent = {
  template: TemplateId | 'custom'
  version: number
  name: string
  shortName: string
  legalBasis: string
  blurb: string
  sections: Array<SectionDef>
  boilerplate: string
  /**
   * The printed content a verbatim template carries beyond its sections.
   * Optional and copied as-is, never defaulted: `canonicalise` drops an
   * undefined key but keeps `null` and `[]`, so writing `terms ?? null` here
   * would change the hash of every v1 snapshot already on a deployment, and
   * production would then mint rows that differ from dev's for identical
   * wording.
   */
  terms?: RichDoc
  print?: PrintSpec
  features?: Array<'durableNotice'>
}

/**
 * Freeze a resolved template.
 *
 * Goes through `sectionsOf()` for the same reason `customTemplates.cloneBuiltin`
 * does: three of the four built-ins still declare a flat `fields` list, and the
 * synthetic `{ title: 'Details', implicit: true }` wrapper that function adds is
 * printed output, not an implementation detail. Both painters render that
 * heading today. A snapshot that normalised it away would silently change what
 * every already-finalised report looks like — the precise thing snapshots
 * exist to prevent.
 */
export function snapshotOf(template: ReportTemplate): TemplateSnapshotContent {
  return {
    template: template.id,
    version: template.version,
    name: template.name,
    shortName: template.shortName,
    legalBasis: template.legalBasis,
    blurb: template.blurb,
    sections: sectionsOf(template),
    boilerplate: template.boilerplate,
    terms: template.terms,
    print: template.print,
    features: template.features,
  }
}

/**
 * A byte-stable serialisation of any JSON value.
 *
 * The reason this exists rather than `JSON.stringify`: the same snapshot is
 * produced from two directions — a module literal, whose keys come out in
 * declaration order, and a Convex read, which returns object fields in sorted
 * key order. Plain stringify gives those two different bytes and therefore
 * different hashes, so `finalise` and the backfill would each mint their own
 * row for identical content and the deduplication would quietly stop working.
 *
 * `undefined` is dropped from objects, matching what a Convex round trip does.
 * Inside an array it is rendered as `null` — Convex rejects `undefined` there
 * outright, so this is a value that cannot survive a write at all; normalising
 * it keeps the function total rather than pretending the two agree.
 */
export function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`)
    return `{${entries.join(',')}}`
  }
  // Functions and symbols cannot reach a snapshot — `TemplateSnapshotContent`
  // is JSON-shaped by construction — but a total function here means a hash
  // can never throw inside `finalise` and block someone signing a document.
  return 'null'
}

/**
 * FNV-1a over the canonical string, hex.
 *
 * Deliberately pure JS rather than `crypto.subtle.digest`: this runs inside a
 * Convex mutation, which is deterministic by construction, and `subtle` is
 * async, which would make every hash an await inside a transaction. A
 * cryptographic digest buys nothing here — the hash is a deduplication key,
 * not a signature, and the writer compares the full canonical string on a hit
 * before reusing a row, so a collision costs one extra row and never the wrong
 * wording.
 */
export function hashSnapshot(content: TemplateSnapshotContent): string {
  const text = canonicalise(content)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // Length is part of the key so two texts that collide in 32 bits still land
  // on different rows unless they are also the same size.
  return `${h.toString(16).padStart(8, '0')}-${text.length.toString(16)}`
}
