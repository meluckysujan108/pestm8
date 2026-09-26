import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import { normaliseAbn } from './lib/abn'
import { normaliseEmail } from './lib/email'
import { normalisePhone } from './lib/phone'
import type { Infer } from 'convex/values'
import { isInScope } from './lib/capabilities'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { redactJobs } from './lib/prices'
import { addressCheck, clientKind, clientStatus } from './schema'
import { assignClientNumber, normaliseTags } from './lib/clientRecord'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx, QueryCtx } from './_generated/server'
import { requireActor } from './lib/actor'

/** Embeds the owning client alongside a property — the detail-view shape
 * (mirrors how `jobs.get` embeds `assignee`/`property` wholesale). */
export async function withClient<T extends Doc<'properties'>>(ctx: QueryCtx, property: T) {
  const client = await ctx.db.get(property.clientId)
  return { ...property, client }
}

/** A property's owning client's name only, for list rows that flatten to a
 * summary string rather than embedding a whole nested object (mirrors how
 * `jobs.ts`'s `decorate()` flattens `assignee` down to `assigneeColour`). */
export async function clientNameOf(
  ctx: QueryCtx,
  property: Doc<'properties'> | null | undefined,
): Promise<string> {
  if (!property) return ''
  const client = await ctx.db.get(property.clientId)
  return client?.name ?? ''
}

export const list = query({
  args: { businessId: v.id('businesses') },
  handler: async (ctx, { businessId }) => {
    const env = await requireActor(ctx, businessId)
    const visible = await visibleClientIds(ctx, env)

    const properties = await ctx.db
      .query('properties')
      .withIndex('by_business', (q) => q.eq('businessId', businessId))
      .collect()
    // Wider than `clients.list`, and easy to miss: this embeds the whole
    // client document on every row, so leaving it unscoped would hand back
    // the same directory plus every service address.
    return Promise.all(
      properties
        .filter((p) => inClientScope(visible, p.clientId))
        .map((p) => withClient(ctx, p)),
    )
  },
})

/**
 * DELIBERATELY NOT SCOPED by the client directory toggle.
 *
 * This is how a technician finds an address when booking, and how
 * `resolvePropertyId` links a job to a site that already exists. Hiding an
 * address they cannot "see" does not stop them booking there — it stops them
 * FINDING it, so they type it again and the business acquires a second
 * property record for the same house, with its own job history and its own
 * reports. A duplicate site in a compliance record is worse than a
 * subcontractor reading a street address they were going to be sent to
 * anyway.
 *
 * The directory is about the client — who they are, their contacts, their
 * portfolio. This is about where the work is.
 */
export const search = query({
  args: { businessId: v.id('businesses'), q: v.string() },
  handler: async (ctx, { businessId, q }) => {
    await requireMembership(ctx, businessId)

    const properties =
      q.trim() === ''
        ? await ctx.db
            .query('properties')
            .withIndex('by_business', (idx) => idx.eq('businessId', businessId))
            .take(50)
        : await ctx.db
            .query('properties')
            .withSearchIndex('search', (s) =>
              s.search('addressLine', q).eq('businessId', businessId),
            )
            .take(50)
    return Promise.all(properties.map((p) => withClient(ctx, p)))
  },
})

export const get = query({
  args: { businessId: v.id('businesses'), propertyId: v.id('properties') },
  handler: async (ctx, { businessId, propertyId }) => {
    await requireMembership(ctx, businessId)

    const property = await ctx.db.get(propertyId)
    // Checking the parent business prevents reading a property by id from
    // another tenant even with a valid membership somewhere.
    if (!property || property.businessId !== businessId) return null
    return withClient(ctx, property)
  },
})

/** Every property a given client owns — used by the client detail sheet's
 * Properties section and by `createForClient` callers that need the
 * up-to-date list after adding one. */
export const listByClient = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireActor(ctx, businessId)

    const client = await ctx.db.get(clientId)
    if (!client || client.businessId !== businessId) return []
    const visible = await visibleClientIds(ctx, env)
    if (!inClientScope(visible, client._id)) return []

    return ctx.db
      .query('properties')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect()
  },
})

/**
 * A site contact as stored: trimmed, and absent when blank. `undefined` in
 * means "not given"; a blank string means "none", which the edit forms send
 * to clear one.
 */
function siteContactField(raw: string | undefined): string | undefined {
  return raw?.trim() || undefined
}

/** The fields of a property at an existing client — "add another property"
 * on the client sheet, and a new site booked straight from the New Job sheet
 * (`newPropertyFields`). */
const propertyAddressFields = {
  addressLine: v.string(),
  suburb: v.string(),
  state: v.string(),
  postcode: v.string(),
  // Prompt 6.3. Only a business client's are shown or dialled
  // (convex/lib/siteContact.ts), but they are stored whatever the kind, the
  // same way a flipped client keeps its contacts.
  siteContactName: v.optional(v.string()),
  siteContactPhone: v.optional(v.string()),
  // How the form saw the address at save: picked from the suggestions and
  // unchanged, or typed. Optional, so every older screen still saves; written
  // with the time only when given.
  addressCheck: v.optional(addressCheck),
}
const propertyAddressObject = v.object(propertyAddressFields)

/**
 * Inserts a property for a client already checked to be this business's.
 * Shared by `createForClient` and `resolvePropertyId`'s new-site branch, so a
 * site added from the client sheet and one added while booking are the same
 * record.
 */
async function insertPropertyForClient(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
  input: Infer<typeof propertyAddressObject>,
): Promise<Id<'properties'>> {
  const siteContactName = siteContactField(input.siteContactName)
  // The number the job card's Call dials for this site, so one that can never
  // be dialled is refused (INVALID_PHONE) rather than found out at the door.
  const siteContactPhone = normalisePhone(input.siteContactPhone)
  const now = Date.now()
  return ctx.db.insert('properties', {
    businessId,
    clientId,
    addressLine: input.addressLine,
    suburb: input.suburb,
    state: input.state,
    postcode: input.postcode,
    ...(siteContactName !== undefined && { siteContactName }),
    ...(siteContactPhone !== undefined && { siteContactPhone }),
    ...(input.addressCheck !== undefined && {
      addressCheck: input.addressCheck,
      addressCheckedAt: now,
    }),
    createdAt: now,
  })
}

async function requireClientOf(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
) {
  const client = await ctx.db.get(clientId)
  if (!client || client.businessId !== businessId) {
    throw new ConvexError('NOT_FOUND')
  }
  return client
}

/** Adds another property to an existing client — the client detail sheet's
 * "add another property" action, distinct from `create` which makes a new
 * client and its first property together in one step. */
export const createForClient = mutation({
  args: {
    businessId: v.id('businesses'),
    clientId: v.id('clients'),
    ...propertyAddressFields,
  },
  handler: async (ctx, { businessId, clientId, ...input }) => {
    await requireMembership(ctx, businessId)
    await requireClientOf(ctx, businessId, clientId)
    return insertPropertyForClient(ctx, businessId, clientId, input)
  },
})

/**
 * A new site for a client that already exists, booked from the New Job sheet
 * (Prompt 6.3): the office is on the phone to a business that has "another
 * rental at 5 X Street". Without it the only way out of the booking sheet was
 * "New client", which gave the same business a second record and split its
 * history across the two.
 */
export const newPropertyFields = v.object({
  clientId: v.id('clients'),
  ...propertyAddressFields,
})

/** The shape every "create a brand-new client" entry point needs — the
 * client-facing counterpart of `properties.create`'s own args, minus
 * `businessId` (the caller already has it). Reused by
 * `jobs.create`/`recurrences.create` so booking a job for a client that
 * doesn't exist yet needs one submit, not a trip to the Clients page first.
 *
 * The one definition of it: `create`'s args, `insertClientAndProperty` and
 * `resolvePropertyId` all derive from this, so a field added here cannot be
 * accepted by a validator and silently dropped on the insert. */
export const newClientFields = v.object({
  clientName: v.string(),
  // Defaults to 'person' so every existing caller (which never passes this)
  // behaves exactly as before.
  kind: v.optional(clientKind),
  phone: v.optional(v.string()),
  email: v.optional(v.string()),
  // Prompt 6.1, a business client's only — ignored for a person, who has
  // neither. An invalid ABN refuses the whole submit, booking included.
  abn: v.optional(v.string()),
  // Becomes the client's primary contact (`clientContacts.isPrimary`), the
  // one "who do we deal with here" — not a second, competing field.
  contactPerson: v.optional(v.string()),
  // A lead not yet booked, say; absent is active.
  status: v.optional(clientStatus),
  tags: v.optional(v.array(v.string())),
  ...propertyAddressFields,
})

type NewClient = Infer<typeof newClientFields>

async function insertClientAndProperty(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  input: NewClient,
): Promise<Id<'properties'>> {
  const kind = input.kind ?? 'person'
  const isBusiness = kind === 'business'
  // Refused before anything is written, though a throw would roll it all back
  // anyway: an ABN that fails the ATO's check is a typo on an invoice.
  const abn = isBusiness ? normaliseAbn(input.abn) : undefined
  // The same for an email that can never be delivered to (INVALID_EMAIL) and
  // a number that can never be dialled (INVALID_PHONE): the booking would
  // otherwise succeed and the report sent to that address simply vanish.
  const email = normaliseEmail(input.email)
  const phone = normalisePhone(input.phone)
  const contactPerson = isBusiness ? input.contactPerson?.trim() : undefined
  const tags = normaliseTags(input.tags ?? [])

  const now = Date.now()
  const clientId = await ctx.db.insert('clients', {
    businessId,
    kind,
    name: input.clientName,
    ...(phone !== undefined && { phone }),
    ...(email !== undefined && { email }),
    ...(abn !== undefined && { abn }),
    clientNumber: await assignClientNumber(ctx, businessId),
    ...(input.status !== undefined && { status: input.status }),
    ...(tags.length > 0 && { tags }),
    createdAt: now,
    updatedAt: now,
  })
  if (contactPerson) {
    await ctx.db.insert('clientContacts', {
      businessId,
      clientId,
      name: contactPerson,
      isPrimary: true,
      createdAt: now,
    })
  }
  // A person client has no site contact: the client IS who is on site.
  return insertPropertyForClient(ctx, businessId, clientId, {
    addressLine: input.addressLine,
    suburb: input.suburb,
    state: input.state,
    postcode: input.postcode,
    addressCheck: input.addressCheck,
    ...(isBusiness && {
      siteContactName: input.siteContactName,
      siteContactPhone: input.siteContactPhone,
    }),
  })
}

/**
 * Resolves a job/recurrence's property from an existing id, a new site for an
 * existing client, or inline new-client fields, inserting what is new in the
 * same mutation — Convex mutations are transactional, so this can never leave
 * an orphaned client or site behind if the rest of the caller's insert fails.
 */
export async function resolvePropertyId(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  input: {
    propertyId?: Id<'properties'>
    newProperty?: Infer<typeof newPropertyFields>
    newClient?: NewClient
  },
): Promise<Id<'properties'>> {
  if (input.propertyId !== undefined) {
    const property = await ctx.db.get(input.propertyId)
    if (!property || property.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    return input.propertyId
  }

  if (input.newProperty) {
    const { clientId, ...site } = input.newProperty
    await requireClientOf(ctx, businessId, clientId)
    return insertPropertyForClient(ctx, businessId, clientId, site)
  }

  if (!input.newClient) throw new ConvexError('MISSING_PROPERTY')
  return insertClientAndProperty(ctx, businessId, input.newClient)
}

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    ...newClientFields.fields,
  },
  handler: async (ctx, { businessId, ...input }) => {
    await requireMembership(ctx, businessId)
    return insertClientAndProperty(ctx, businessId, input)
  },
})

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    propertyId: v.id('properties'),
    addressLine: v.optional(v.string()),
    suburb: v.optional(v.string()),
    state: v.optional(v.string()),
    postcode: v.optional(v.string()),
    // A blank string clears it; leaving it out leaves it alone.
    siteContactName: v.optional(v.string()),
    siteContactPhone: v.optional(v.string()),
    // How the address was entered this time; see the schema. Left alone
    // when not given, so an older screen's save keeps the last one.
    addressCheck: v.optional(addressCheck),
  },
  handler: async (
    ctx,
    {
      businessId,
      propertyId,
      siteContactName,
      siteContactPhone,
      addressCheck: check,
      ...address
    },
  ) => {
    await requireMembership(ctx, businessId)

    const property = await ctx.db.get(propertyId)
    if (!property || property.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    // Typed explicitly for the same reason as `clients.update`: the optional
    // args really can arrive absent, but `Object.entries` infers them away,
    // which makes a necessary runtime filter read as dead code.
    const fields: Record<string, string | undefined> = Object.fromEntries(
      Object.entries<string | undefined>(address).filter(
        ([, value]) => value !== undefined,
      ),
    )
    // Written as `undefined` when cleared — which is how a patch removes a
    // field. Without this a blank would be stored as an empty string, and a
    // site contact who moved on could never be taken off again.
    if (siteContactName !== undefined) {
      fields.siteContactName = siteContactField(siteContactName)
    }
    // Checked only when this save changes it: the form sends it back with
    // every edit, and a site saved before the rule must stay editable.
    if (siteContactPhone !== undefined) {
      fields.siteContactPhone =
        siteContactPhone.trim() === (property.siteContactPhone ?? '').trim()
          ? siteContactField(siteContactPhone)
          : normalisePhone(siteContactPhone)
    }
    if (Object.keys(fields).length > 0 || check !== undefined) {
      await ctx.db.patch(propertyId, {
        ...fields,
        ...(check !== undefined && {
          addressCheck: check,
          addressCheckedAt: Date.now(),
        }),
      })
    }
  },
})

/**
 * Job history for a property. Read visibility still applies: a subcontractor
 * without canViewAllJobs sees only their own visits to this address.
 */
export const jobHistory = query({
  args: { businessId: v.id('businesses'), propertyId: v.id('properties') },
  handler: async (ctx, { businessId, propertyId }) => {
    const { scope, caps } = await requireActor(ctx, businessId)

    const property = await ctx.db.get(propertyId)
    if (!property || property.businessId !== businessId) return []

    const jobs = await ctx.db
      .query('jobs')
      .withIndex('by_property', (q) => q.eq('propertyId', propertyId))
      .order('desc')
      .collect()

    // Redacted like every other job read — see `clients.jobHistory`.
    return redactJobs(
      caps,
      jobs.filter((j) => isInScope(scope, j)),
    )
  },
})
