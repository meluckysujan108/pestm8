/// <reference types="vite/client" />
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, internal } from './_generated/api'
import { createActor, createBusiness, testApp } from '../test/harness'
import { getTemplate } from '../src/lib/reportTemplates'
import { CLAIM_WINDOW_MS } from './lib/products'
import { RENDER_VERSION } from './reports'
import type { Id } from './_generated/dataModel'

/**
 * The logo on the letterhead (`businesses.setLogo`), and the report email
 * that heads with it.
 *
 * A logo is two files the browser draws from one upload: the logo the PDF
 * prints, and its copy on a white card for email. An optional second pair is
 * the logo with light lettering, which an email swaps in for dark mode.
 */

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function setup() {
  const t = testApp()
  const owner = await createActor(t, {
    email: 'terence@pestm8.test',
    name: 'Terence',
  })
  const { businessId, ownerMembershipId } = await createBusiness(
    t,
    owner,
    'Pest M8 Pest Control',
  )
  return { t, owner, businessId, ownerMembershipId }
}

type Setup = Awaited<ReturnType<typeof setup>>

let uploads = 0

/** A file as the browser's POST to an upload URL leaves one, claimed by
 * nothing. (convex-test records no content type, and names a file by its
 * bytes — so each is made different.) */
function upload(s: Setup, bytes: BlobPart = `png ${++uploads}`) {
  return s.t.run((ctx) => ctx.storage.store(new Blob([bytes])))
}

/** A logo and its email card, fresh from the browser. */
async function logoFiles(s: Setup) {
  return {
    storageId: await upload(s),
    email: { storageId: await upload(s), width: 220, height: 72 },
  }
}

function business(s: Setup) {
  return s.t.run((ctx) => ctx.db.get(s.businessId))
}

function setLogo(
  s: Setup,
  which: 'logo' | 'logoOnDark',
  files: Awaited<ReturnType<typeof logoFiles>> | null,
) {
  return s.owner.as.mutation(api.businesses.setLogo, {
    businessId: s.businessId,
    which,
    files,
  })
}

function auditFields(s: Setup) {
  return s.t.run(async (ctx) =>
    (await ctx.db.query('auditLog').collect())
      .filter((row) => row.action === 'business.update')
      .map((row) => (row.meta as { fields: Array<string> }).fields),
  )
}

describe('putting a logo on the letterhead', () => {
  test('an owner sets the logo and its email card together, and the change is recorded', async () => {
    const s = await setup()
    const files = await logoFiles(s)

    await setLogo(s, 'logo', files)

    expect(await business(s)).toMatchObject({
      logoStorageId: files.storageId,
      logoEmail: files.email,
    })
    const shell = await s.owner.as.query(api.businesses.getBySlug, {
      slug: 'pest-m8-pest-control',
    })
    expect(shell?.logoUrl).toBeTruthy()
    expect(await auditFields(s)).toEqual([['logoStorageId', 'logoEmail']])
  })

  test('taking it off clears both, and keeps the files for what was already issued', async () => {
    const s = await setup()
    const files = await logoFiles(s)
    await setLogo(s, 'logo', files)

    await setLogo(s, 'logo', null)

    const after = await business(s)
    expect(after?.logoStorageId).toBeUndefined()
    expect(after?.logoEmail).toBeUndefined()
    // A report locked with it prints it for good, and a sent email shows it.
    const kept = await s.t.run(async (ctx) => [
      await ctx.db.system.get('_storage', files.storageId),
      await ctx.db.system.get('_storage', files.email.storageId),
    ])
    expect(kept.every((file) => file !== null)).toBe(true)
  })

  test('the light-lettered logo is separate and optional, and Settings reads it back', async () => {
    const s = await setup()
    const settings = () =>
      s.owner.as.query(api.businesses.reportSettings, {
        businessId: s.businessId,
      })
    expect((await settings())?.logoOnDarkUrl).toBeNull()

    const dark = await logoFiles(s)
    await setLogo(s, 'logoOnDark', dark)
    expect((await business(s))?.logoOnDark).toEqual(dark)
    expect((await settings())?.logoOnDarkUrl).toBeTruthy()

    // Changing the logo leaves the dark one alone…
    await setLogo(s, 'logo', await logoFiles(s))
    expect((await business(s))?.logoOnDark).toEqual(dark)

    // …and it comes off on its own.
    await setLogo(s, 'logoOnDark', null)
    expect((await business(s))?.logoOnDark).toBeUndefined()
    expect((await settings())?.logoOnDarkUrl).toBeNull()
  })
})

describe('what may become a logo', () => {
  test('only a file uploaded in the last few minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    const start = Date.now()
    const files = await logoFiles(s)

    vi.setSystemTime(start + CLAIM_WINDOW_MS + 1000)
    await expect(setLogo(s, 'logo', files)).rejects.toThrow(/FILE_NOT_FOUND/)
    expect((await business(s))?.logoStorageId).toBeUndefined()
  })

  test('never a file something else already holds — a product’s photo, say', async () => {
    const s = await setup()
    const files = await logoFiles(s)
    await s.t.run((ctx) =>
      ctx.db.insert('products', {
        businessId: s.businessId,
        name: 'Termidor',
        nameKey: 'termidor',
        photoStorageId: files.email.storageId,
        createdByMembershipId: s.ownerMembershipId,
        updatedByMembershipId: s.ownerMembershipId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    )

    await expect(setLogo(s, 'logo', files)).rejects.toThrow(/ALREADY_ATTACHED/)
    expect((await business(s))?.logoStorageId).toBeUndefined()
  })

  test('not one file as both, and not a card no browser here would draw', async () => {
    const s = await setup()
    const logo = await upload(s)
    await expect(
      setLogo(s, 'logo', {
        storageId: logo,
        email: { storageId: logo, width: 220, height: 72 },
      }),
    ).rejects.toThrow(/WRONG_FILE_TYPE/)

    const files = await logoFiles(s)
    await expect(
      setLogo(s, 'logo', {
        ...files,
        email: { ...files.email, width: 800, height: 360 },
      }),
    ).rejects.toThrow(/INVALID_SIZE/)
  })

  test('only by someone who may change the letterhead', async () => {
    const s = await setup()
    const sub = await createActor(s.t, {
      email: 'kev@pestm8.test',
      name: 'Kevin',
    })
    await s.t.run((ctx) =>
      ctx.db.insert('memberships', {
        userId: sub.userId,
        businessId: s.businessId,
        role: 'subcontractor',
        canViewAllJobs: false,
        colour: '#34C759',
        status: 'active',
        createdAt: Date.now(),
      }),
    )
    await expect(
      sub.as.mutation(api.businesses.setLogo, {
        businessId: s.businessId,
        which: 'logo',
        files: await logoFiles(s),
      }),
    ).rejects.toThrow(/NO_ACCESS/)
  })
})

describe('a logo sent the old way, by a phone still on the previous app', () => {
  test('is claimed the same way, and its stale email card goes with the logo it replaced', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const s = await setup()
    await setLogo(s, 'logo', await logoFiles(s))
    const update = (logoStorageId: Id<'_storage'>) =>
      s.owner.as.mutation(api.businesses.update, {
        businessId: s.businessId,
        logoStorageId,
      })

    const replacement = await upload(s)
    await update(replacement)
    const after = await business(s)
    expect(after?.logoStorageId).toBe(replacement)
    // The card showed the old logo; until a new one is drawn, emails carry
    // this logo itself.
    expect(after?.logoEmail).toBeUndefined()

    // The same one sent back is not a change.
    const before = await auditFields(s)
    await update(replacement)
    expect(await auditFields(s)).toEqual(before)

    const stale = await upload(s)
    vi.setSystemTime(Date.now() + CLAIM_WINDOW_MS + 1000)
    await expect(update(stale)).rejects.toThrow(/FILE_NOT_FOUND/)
  })
})

describe('the letterhead a report email heads with', () => {
  test('is the card and its size; a logo from before cards comes without one', async () => {
    const s = await setup()
    const letterhead = () =>
      s.t.query(internal.businesses.emailLetterhead, {
        businessId: s.businessId,
      })
    expect(await letterhead()).toEqual({ logo: null, logoOnDark: null })

    const files = await logoFiles(s)
    await setLogo(s, 'logo', files)
    expect(await letterhead()).toMatchObject({
      logo: { width: 220, height: 72, carded: true },
      logoOnDark: null,
    })

    // Stored before cards existed: the logo itself, its size unknown here.
    await s.t.run((ctx) => ctx.db.patch(s.businessId, { logoEmail: undefined }))
    expect(await letterhead()).toMatchObject({
      logo: { width: null, height: null, carded: false },
    })
  })
})

describe('the email Resend is asked to send', () => {
  /** A finished report, drawn already, with a delivery queued for it. */
  async function queued(
    s: Setup,
    frozenLogo?: Id<'_storage'>,
  ): Promise<Id<'reportDeliveries'>> {
    const reportId = await s.t.run(async (ctx) => {
      const now = Date.now()
      const clientId = await ctx.db.insert('clients', {
        businessId: s.businessId,
        kind: 'person',
        name: 'Jane Nguyen',
        email: 'jane@gmail.com',
        createdAt: now,
        updatedAt: now,
      })
      const propertyId = await ctx.db.insert('properties', {
        businessId: s.businessId,
        clientId,
        addressLine: '30 Sloan Drive',
        suburb: 'Leda',
        state: 'WA',
        postcode: '6170',
        createdAt: now,
      })
      const pdf = await ctx.storage.store(
        new Blob(['%PDF-1.7 test'], { type: 'application/pdf' }),
      )
      return ctx.db.insert('reports', {
        businessId: s.businessId,
        propertyId,
        authorMembershipId: s.ownerMembershipId,
        template: 'serviceReport',
        templateVersion: getTemplate('serviceReport').version,
        legalBasis: 'APVMA · AEPMA',
        status: 'finalised',
        finalisedAt: now,
        data: {},
        photoIds: [],
        createdAt: now,
        pdfStorageId: pdf,
        pdfRenderVersion: RENDER_VERSION,
        pdfStatus: 'ready',
        ...(frozenLogo
          ? {
              contextSnapshot: {
                capturedAt: now,
                client: null,
                property: null,
                business: {
                  name: 'Pest M8 Pest Control',
                  logoStorageId: frozenLogo,
                },
                technician: null,
                author: { membershipId: s.ownerMembershipId },
                roster: {},
              },
            }
          : {}),
      })
    })
    return s.t.mutation(internal.deliveries.queue, {
      reportId,
      to: ['jane@gmail.com'],
      cc: [],
      bcc: [],
      subject: 'Service Report',
      trigger: 'manual',
      status: 'queued',
      sentByMembershipId: s.ownerMembershipId,
    })
  }

  /** Resend, faked; any other address answers with `other`. */
  function fakeResend(other: (url: string) => Response) {
    vi.stubEnv('RESEND_API_KEY', 're_test')
    vi.stubEnv('RESEND_FROM_EMAIL', 'info@pestm8.com.au')
    const sent: Array<{ html: string; text: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://api.resend.com/emails') {
          sent.push(JSON.parse(String(init?.body)) as never)
          return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 })
        }
        return other(url)
      }),
    )
    return sent
  }

  const pdf = () => new Response(new Blob(['%PDF-1.7 test']), { status: 200 })

  test('heads with the business’s logo as it is now, not the one the report was locked with', async () => {
    const s = await setup()
    const old = await upload(s)
    const files = await logoFiles(s)
    const dark = await logoFiles(s)
    await setLogo(s, 'logo', files)
    await setLogo(s, 'logoOnDark', dark)
    const deliveryId = await queued(s, old)
    const sent = fakeResend(pdf)

    expect(await s.t.action(internal.email.deliver, { deliveryId })).toEqual({
      ok: true,
    })

    const [card, onDark, lockedWith] = await s.t.run(async (ctx) => [
      await ctx.storage.getUrl(files.email.storageId),
      await ctx.storage.getUrl(dark.email.storageId),
      await ctx.storage.getUrl(old),
    ])
    const { html, text } = sent[0]
    expect(html).toContain(
      `<img class="pm-ink pm-on-light" src="${card}" width="220" height="72" alt="Pest M8 Pest Control"`,
    )
    expect(html).toContain(`class="pm-ink pm-on-dark" src="${onDark}"`)
    expect(html).not.toContain(String(lockedWith))
    // And the words again, as plain text beside it.
    expect(text).toContain('The full report is attached as a PDF.')
  })

  test('a logo from before cards is sized from its own file', async () => {
    const s = await setup()
    // The first bytes of a 1246 × 326 PNG are all its size needs.
    const header = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48,
      0x44, 0x52, 0, 0, 0x04, 0xde, 0, 0, 0x01, 0x46, 8, 6, 0, 0, 0,
    ])
    const logo = await upload(s, header)
    await s.t.run((ctx) => ctx.db.patch(s.businessId, { logoStorageId: logo }))
    const logoUrl = await s.t.run((ctx) => ctx.storage.getUrl(logo))
    const deliveryId = await queued(s)
    const sent = fakeResend((url) =>
      url === logoUrl ? new Response(header, { status: 200 }) : pdf(),
    )

    await s.t.action(internal.email.deliver, { deliveryId })

    expect(sent[0].html).toContain(
      `<div style="display:block;padding:10px;"><img class="pm-ink" src="${logoUrl}" width="200" height="52"`,
    )
  })

  test('a logo that cannot be read never stops the email: the name heads it instead', async () => {
    const s = await setup()
    const logo = await upload(s, 'not a picture')
    await s.t.run((ctx) => ctx.db.patch(s.businessId, { logoStorageId: logo }))
    const deliveryId = await queued(s)
    const sent = fakeResend(pdf)

    expect(await s.t.action(internal.email.deliver, { deliveryId })).toEqual({
      ok: true,
    })
    expect(sent[0].html).not.toContain('<img')
    expect(sent[0].html).toContain('>Pest M8 Pest Control</div>')
  })
})
