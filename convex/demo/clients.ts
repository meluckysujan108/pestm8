import { v } from 'convex/values'
import { internalMutation } from '../_generated/server'
import { resolvePropertyId } from '../properties'
import { CLIENTS, clientMapV, demoBaseV, propertyMapV } from './shared'
import type { Id } from '../_generated/dataModel'

/**
 * The demo's clients, their properties and contacts (convex/demo/shared.ts
 * CLIENTS), written the way the app writes them: each client arrives with its
 * first property through `resolvePropertyId` (properties.create's path), later
 * properties as the client sheet's "Add another property" inserts them, the
 * head office as clients.update adds it, contacts as clientContacts.create
 * does, a primary as setPrimary leaves it, and an archive as clients.archive.
 */
export const seed = internalMutation({
  args: { base: demoBaseV },
  returns: v.object({ properties: propertyMapV, clients: clientMapV }),
  handler: async (ctx, { base }) => {
    const properties: Record<string, Id<'properties'>> = {}
    const clients: Record<string, Id<'clients'>> = {}

    for (const spec of CLIENTS) {
      const [first, ...more] = spec.properties
      const firstId = await resolvePropertyId(ctx, base.businessId, {
        newClient: {
          clientName: spec.name,
          kind: spec.kind,
          ...(spec.phone ? { phone: spec.phone } : {}),
          ...(spec.email ? { email: spec.email } : {}),
          addressLine: first.addressLine,
          suburb: first.suburb,
          state: first.state,
          postcode: first.postcode,
        },
      })
      const firstProperty = await ctx.db.get(firstId)
      if (!firstProperty) throw new Error(`property for ${spec.key} vanished`)
      const clientId = firstProperty.clientId
      clients[spec.key] = clientId
      properties[first.key] = firstId

      for (const property of more) {
        properties[property.key] = await ctx.db.insert('properties', {
          businessId: base.businessId,
          clientId,
          addressLine: property.addressLine,
          suburb: property.suburb,
          state: property.state,
          postcode: property.postcode,
          createdAt: Date.now(),
        })
      }

      if (spec.headOffice) {
        await ctx.db.patch(clientId, {
          ...spec.headOffice,
          updatedAt: Date.now(),
        })
      }

      for (const contact of spec.contacts ?? []) {
        await ctx.db.insert('clientContacts', {
          businessId: base.businessId,
          clientId,
          name: contact.name,
          ...(contact.role ? { role: contact.role } : {}),
          ...(contact.phone ? { phone: contact.phone } : {}),
          ...(contact.email ? { email: contact.email } : {}),
          // Absent unless setPrimary has touched it: true for the primary,
          // false for one it demoted.
          ...(contact.isPrimary !== undefined
            ? { isPrimary: contact.isPrimary }
            : {}),
          createdAt: Date.now(),
        })
      }

      if (spec.archived) {
        // clients.archive: the archive stamp alone, updatedAt untouched.
        await ctx.db.patch(clientId, { archivedAt: Date.now() })
      }
    }

    return { properties, clients }
  },
})
