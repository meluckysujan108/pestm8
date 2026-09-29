import { ConvexError, v } from 'convex/values'
import { internalMutation } from '../_generated/server'
import { claimLogoFile } from '../businesses'
import { isEmailCardSize } from '../lib/businessLogo'
import { logoEmailImage } from '../schema'

/**
 * One-off (the product owner's instruction of 29 Sept 2026): put Pest M8 Pest
 * Control's logo on its letterhead — transparent, as its owner asked for it on
 * every report and email — with its version in white lettering for emails read
 * in dark mode.
 *
 * Nobody who can reach Settings → Business for that business was at hand, so
 * the four files were drawn by the same code the browser runs
 * (src/lib/images/prepareLogo.ts), from the artwork the product owner supplied,
 * and are put on here by the rules `businesses.setLogo` applies: each a fresh
 * PNG that nothing else holds, and each card a size a card could have.
 *
 * GUARDS: the business is named, and must still be called what the operator
 * says; and it must still have the logo the operator saw — on 29 Sept 2026,
 * the 800 × 360 JPEG — so a logo the owner has changed since is left alone,
 * and a second run changes nothing. A dry run says what it would do without
 * writing. No audit row: the log names a member of the business as having made
 * each change, and none did; this file and its commit are the record.
 *
 * For production (CLAUDE.md), every command names its deployment:
 *
 *   1. UPLOAD each file to a URL from `uploadUrl`, as the browser does:
 *      CONVEX_DEPLOYMENT=prod:rare-retriever-156 npx convex run migrations/letterheadPestM8V1:uploadUrl
 *      curl -X POST -H 'Content-Type: image/png' --data-binary @<file> <url>
 *   2. PREVIEW: … migrations/letterheadPestM8V1:run '{"dryRun":true,
 *      "businessId":"j9798zawavrfej4q05gc5hrqes8ea5e1",
 *      "businessName":"Pest M8 Pest Control",
 *      "expectLogo":"kg26ayyj808jy6gkw0q6g9ep6n8fbtqm", "logo":…, "logoOnDark":…}'
 *   3. RUN, within 15 minutes of the uploads: the same without dryRun.
 */

/** A short-lived URL to POST one file to. */
export const uploadUrl = internalMutation({
  args: {},
  handler: (ctx) => ctx.storage.generateUploadUrl(),
})

const files = v.object({ storageId: v.id('_storage'), email: logoEmailImage })

export const run = internalMutation({
  args: {
    dryRun: v.boolean(),
    businessId: v.id('businesses'),
    /** What it is called, as a check on the id. */
    businessName: v.string(),
    /** The logo it has now, as the operator saw it. */
    expectLogo: v.id('_storage'),
    logo: files,
    logoOnDark: files,
  },
  handler: async (
    ctx,
    { dryRun, businessId, businessName, expectLogo, logo, logoOnDark },
  ) => {
    const business = await ctx.db.get(businessId)
    if (!business || business.name !== businessName) {
      throw new ConvexError('NOT_FOUND')
    }
    if (
      business.logoStorageId === logo.storageId &&
      business.logoOnDark?.storageId === logoOnDark.storageId
    ) {
      return { status: 'already done' as const }
    }
    if (business.logoStorageId !== expectLogo) {
      return { status: 'left alone: the logo has changed' as const }
    }

    const ids = [
      logo.storageId,
      logo.email.storageId,
      logoOnDark.storageId,
      logoOnDark.email.storageId,
    ]
    if (new Set(ids).size !== ids.length) {
      throw new ConvexError('WRONG_FILE_TYPE')
    }
    if (!isEmailCardSize(logo.email) || !isEmailCardSize(logoOnDark.email)) {
      throw new ConvexError('INVALID_SIZE')
    }
    for (const id of ids) await claimLogoFile(ctx, id)

    const fields = {
      logoStorageId: logo.storageId,
      logoEmail: logo.email,
      logoOnDark,
    }
    if (dryRun) return { status: 'would set' as const, fields }
    await ctx.db.patch(businessId, fields)
    return { status: 'set' as const, fields }
  },
})
