import type { Doc } from '../_generated/dataModel'
import type { Grants, Licence, MembershipFacts } from './capabilities'
import { DEFAULT_GRANTS } from './capabilities'

/**
 * The bridge between a stored membership row and the access model.
 *
 * `capabilities.ts` is deliberately schema-agnostic — it takes a structural
 * `MembershipFacts` so a test can build one by hand. This is the one place
 * that knows the column names, which means it is also the one place where the
 * schema and the model can drift apart. Everything that resolves an actor goes
 * through here.
 *
 * Its real job is the EXPAND-phase question: what does a row written before
 * any of this existed mean? Every membership in production is such a row. Get
 * the answer wrong in one direction and the whole team loses access the moment
 * the backend deploys — ahead of the frontend, which is a separate build
 * (CLAUDE.md). Get it wrong in the other and a deploy silently hands people
 * access nobody granted.
 */

/**
 * A legacy row's toggles, derived to mean exactly what the app does TODAY.
 *
 * Today every member can read the client book and see prices (audit finding
 * #3 — that is the hole this model exists to close). So that is what a
 * pre-migration row must resolve to. Tightening is the MIGRATE step's job,
 * where it happens once, deliberately, from the owner's actual choices, and is
 * visible in a UI that can explain it. Tightening HERE would mean a backend
 * deploy quietly cutting a technician off from their client list mid-shift,
 * with no UI anywhere yet to show what happened or to turn it back on.
 *
 * The one thing deliberately NOT carried across is `canViewOtherAccounts`.
 * It reads like the ancestor of `switchInto` and it is not: it grants a
 * read-only "view as", where `switchInto` grants writing — finalising reports
 * included — under someone else's name. Mapping the old flag onto the new one
 * would turn every existing read-only grant into full write access on deploy,
 * which is exactly the kind of upgrade-by-accident nobody would find in a
 * diff. Legacy rows therefore start with no switch grant at all, and the owner
 * gives it out explicitly.
 */
export function grantsFromMembership(m: Doc<'memberships'>): Grants {
  if (m.grants) return m.grants

  if (m.role === 'owner') return DEFAULT_GRANTS.owner

  return {
    switchInto: null,
    // Today's behaviour, not tomorrow's policy. See above.
    clientDirectory: true,
    prices: true,
    // The one legacy flag that does map cleanly: both mean "can see work that
    // isn't yours", and both are read-only.
    otherSchedules: m.canViewAllJobs === true,
  }
}

/** Absent expiry reads as "unknown", never as "expired" — `licenceStatus`
 * treats it as valid, so nobody is blocked from finalising by a column that
 * has never been filled in. A row with no licence number at all has no
 * licence, which is a different thing and does block regulated work. */
export function licenceFromMembership(m: Doc<'memberships'>): Licence | null {
  if (!m.licenceNumber) return null
  return { number: m.licenceNumber, expiresAt: m.licenceExpiresOn }
}

export function factsFromMembership(m: Doc<'memberships'>): MembershipFacts {
  return {
    _id: m._id,
    businessId: m.businessId,
    // No cast: the schema's `role` validator and the model's `Role` are the
    // same three literals, and TypeScript will say so the moment they stop
    // being — which is the point of widening the union in schema.ts rather
    // than writing the roles out again here.
    role: m.role,
    status: m.status,
    parentMembershipId: m.parentMembershipId ?? null,
    grants: grantsFromMembership(m),
    licence: licenceFromMembership(m),
  }
}

/** The name attribution should print. Falls back to the live user name only
 * while no snapshot exists; see `memberships.displayName` in schema.ts for why
 * the snapshot has to win once it is there. */
export function displayNameOf(
  m: Doc<'memberships'>,
  liveName: string | undefined,
): string {
  return m.displayName ?? liveName ?? 'Unknown'
}
