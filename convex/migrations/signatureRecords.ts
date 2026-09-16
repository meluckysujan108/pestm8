import { v } from 'convex/values'
import { internalMutation, internalQuery } from '../_generated/server'
import { internal } from '../_generated/api'

/**
 * Signatures gain their own provenance.
 *
 * A slot used to hold a bare storage id — the image, and nothing about the act
 * of signing. What makes an electronic signature stand up is the link between
 * a person, that act and the document: when it was signed, by whom, against
 * which words, on which revision of the form. New signatures record all of it;
 * this pass converts the ones already stored.
 *
 * RUNBOOK
 *
 * 1. EXPAND — already shipped with this file. `reports.signatureSlots` accepts
 *    either shape, and every reader goes through `storageIdOf()`, so nothing
 *    needs converting for the app to keep working.
 *
 * 2. MIGRATE — `npx convex run migrations/signatureRecords:backfill '{"cursor":null}'`,
 *    then again with `--prod`. Confirm `--prod` resolves to the intended
 *    deployment first: `.env.local` points at dev.
 *
 * 3. VERIFY — `npx convex run migrations/signatureRecords:invariant` must
 *    report `bareStorageIds: 0` on both.
 *
 * 4. CONTRACT (later, its own deploy) — drop the `v.id('_storage')` arm of the
 *    union, once both deployments report zero.
 *
 * What it CANNOT recover is honest about itself: an old row knows only the
 * image. `signedAt` is taken from the report's own answers where the pad wrote
 * one there and falls back to when the report was created; `method` is
 * `'drawn'`, which is the only way a signature could have been made then; and
 * `signedBy`, `statement` and `capturedByMembershipId` are left absent rather
 * than invented. An empty field is a fact; a fabricated one is a lie about
 * evidence.
 */

const PAGE = 100

export const backfill = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('reports').paginate({ numItems: PAGE, cursor })

    for (const report of page.page) {
      const slots = report.signatureSlots
      if (!slots) continue

      const bare = Object.entries(slots).flatMap(([slot, held]) =>
        typeof held === 'string' ? [[slot, held] as const] : [],
      )
      if (bare.length === 0) continue

      const data = (report.data ?? {}) as Record<string, unknown>
      const converted = { ...slots }
      for (const [slot, storageId] of bare) {
        converted[slot] = {
          storageId,
          signedAt: signedAtFor(data, slot) ?? report.createdAt,
          method: 'drawn' as const,
          templateVersion: report.templateVersion,
        }
      }

      await ctx.db.patch(report._id, { signatureSlots: converted })
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.signatureRecords.backfill, {
        cursor: page.continueCursor,
      })
    }
  },
})

/**
 * When the pad recorded a signing time in the answers.
 *
 * The slot and the field key are different names for the same signature
 * ('technician' vs 'technicianSignature'), and a template may use either, so
 * this looks for any answer shaped like a signature whose key mentions the
 * slot rather than assuming one naming convention.
 */
function signedAtFor(data: Record<string, unknown>, slot: string): number | undefined {
  for (const [key, value] of Object.entries(data)) {
    if (!key.toLowerCase().includes(slot.toLowerCase())) continue
    if (typeof value !== 'object' || value === null) continue
    const signedAt = (value as { signedAt?: unknown }).signedAt
    if (typeof signedAt === 'number') return signedAt
  }
  return undefined
}

export const invariant = internalQuery({
  args: {},
  handler: async (ctx) => {
    const reports = await ctx.db.query('reports').collect()

    let signatures = 0
    let bareStorageIds = 0
    for (const report of reports) {
      for (const held of Object.values(report.signatureSlots ?? {})) {
        signatures++
        if (typeof held === 'string') bareStorageIds++
      }
    }

    return { reports: reports.length, signatures, bareStorageIds }
  },
})
