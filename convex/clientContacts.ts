import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMembership } from './lib/access'
import { requireActor } from './lib/actor'
import { inClientScope, visibleClientIds } from './lib/clientScope'
import { isNameCorrection, sameName } from './lib/contactNames'
import type { Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

/**
 * Makes `rawName` a business client's contact person (Prompt 6.1) — its
 * primary contact, the one "who do we deal with here". There is no separate
 * contact-person field: a second one would drift from the Contacts list, and
 * the contacts' emails already feed report recipients.
 *
 * Never removes anyone from the list. Blank takes the star off whoever has
 * it. A name already in the list takes the star. A correction of the contact
 * person's own name (`isNameCorrection`) renames them in place, keeping their
 * number and role: adding Jan's surname must not leave two Jans, one without
 * a phone. Any other name is a different person, added with the star, and
 * whoever had it stays in the list.
 */
export async function setContactPerson(
  ctx: MutationCtx,
  businessId: Id<'businesses'>,
  clientId: Id<'clients'>,
  rawName: string,
) {
  const name = rawName.trim()
  const contacts = await ctx.db
    .query('clientContacts')
    .withIndex('by_client', (q) => q.eq('clientId', clientId))
    .collect()
  const primary = contacts.find((c) => c.isPrimary)

  let contactId: Id<'clientContacts'> | null
  if (name === '') {
    contactId = null
  } else if (primary && sameName(primary.name, name)) {
    if (primary.name !== name) await ctx.db.patch(primary._id, { name })
    contactId = primary._id
  } else {
    const named = contacts.find((c) => sameName(c.name, name))
    if (named) {
      contactId = named._id
    } else if (primary && isNameCorrection(primary.name, name)) {
      await ctx.db.patch(primary._id, { name })
      contactId = primary._id
    } else {
      contactId = await ctx.db.insert('clientContacts', {
        businessId,
        clientId,
        name,
        createdAt: Date.now(),
      })
    }
  }

  // Exclusive per client, as `setPrimary` keeps it — and on every path, so a
  // client whose rows have somehow drifted to two stars comes out with one.
  await Promise.all(
    contacts
      .filter((c) => c.isPrimary && c._id !== contactId)
      .map((c) => ctx.db.patch(c._id, { isPrimary: false })),
  )
  if (contactId !== null && contactId !== primary?._id) {
    await ctx.db.patch(contactId, { isPrimary: true })
  }
}

export const list = query({
  args: { businessId: v.id('businesses'), clientId: v.id('clients') },
  handler: async (ctx, { businessId, clientId }) => {
    const env = await requireActor(ctx, businessId)

    const client = await ctx.db.get(clientId)
    if (!client || client.businessId !== businessId) return []
    // Names, numbers and email addresses for a client they may not see are
    // the most sensitive part of the directory, not an afterthought to it.
    const visible = await visibleClientIds(ctx, env)
    if (!inClientScope(visible, client._id)) return []

    return ctx.db
      .query('clientContacts')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .collect()
  },
})

export const create = mutation({
  args: {
    businessId: v.id('businesses'),
    clientId: v.id('clients'),
    name: v.string(),
    role: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, clientId, ...rest }) => {
    await requireMembership(ctx, businessId)

    const client = await ctx.db.get(clientId)
    if (!client || client.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    return ctx.db.insert('clientContacts', {
      businessId,
      clientId,
      ...rest,
      createdAt: Date.now(),
    })
  },
})

export const update = mutation({
  args: {
    businessId: v.id('businesses'),
    contactId: v.id('clientContacts'),
    name: v.optional(v.string()),
    role: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
  },
  handler: async (ctx, { businessId, contactId, ...patch }) => {
    await requireMembership(ctx, businessId)

    const contact = await ctx.db.get(contactId)
    if (!contact || contact.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    // Typed explicitly, as in clients.update and properties.update: the
    // optional args really can arrive absent, but `Object.entries` infers them
    // away, which makes a necessary runtime filter read as dead code.
    const fields = Object.fromEntries(
      Object.entries<string | undefined>(patch).filter(
        ([, value]) => value !== undefined,
      ),
    )
    if (Object.keys(fields).length > 0) await ctx.db.patch(contactId, fields)
  },
})

/** Exclusive per client, mirroring `reports.setGalleryCover` exactly. */
export const setPrimary = mutation({
  args: { businessId: v.id('businesses'), contactId: v.id('clientContacts') },
  handler: async (ctx, { businessId, contactId }) => {
    await requireMembership(ctx, businessId)

    const contact = await ctx.db.get(contactId)
    if (!contact || contact.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }

    const siblings = await ctx.db
      .query('clientContacts')
      .withIndex('by_client', (q) => q.eq('clientId', contact.clientId))
      .collect()

    await Promise.all(
      siblings
        .filter((sibling) => sibling.isPrimary && sibling._id !== contactId)
        .map((sibling) => ctx.db.patch(sibling._id, { isPrimary: false })),
    )
    await ctx.db.patch(contactId, { isPrimary: true })
  },
})

export const remove = mutation({
  args: { businessId: v.id('businesses'), contactId: v.id('clientContacts') },
  handler: async (ctx, { businessId, contactId }) => {
    await requireMembership(ctx, businessId)

    const contact = await ctx.db.get(contactId)
    if (!contact || contact.businessId !== businessId) {
      throw new ConvexError('NOT_FOUND')
    }
    await ctx.db.delete(contactId)
  },
})
