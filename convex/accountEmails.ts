import { v } from 'convex/values'
import type { Infer } from 'convex/values'
import { components, internal } from './_generated/api'
import {
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server'
import { accountEmailFrom } from './lib/emailConfig'
import {
  APP_MARK_PATH,
  emailWhen,
  memberXeroConnectedEmail,
  passwordChangedEmail,
  passwordResetEmail,
  xeroConnectedEmail,
} from './lib/accountEmail'
import type { Doc } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'

/**
 * Emails about someone's own account, from `RESEND_ACCOUNT_FROM_EMAIL`
 * (noreply@) — a password-reset link, "your password was changed", and a
 * Xero organisation connected (`queueXeroConnected`).
 *
 * Better Auth decides when one is due (`emailAndPassword` in convex/auth.ts);
 * this writes a row and schedules the send, and the send runs on its own.
 * Scheduled rather than sent inside the request, so asking for a reset takes
 * the same time whether or not the address has an account: a reply that came
 * back slower when an email went out would say who is signed up.
 *
 * Only the row's facts are stored — what, to whom, and what the provider said.
 * The reset link travels in the scheduled send's arguments and nowhere else.
 */

/** No second reset email to one address within this long of the last. */
export const RESET_MIN_GAP_MS = 2 * 60 * 1000
/** And no more than this many a day. */
export const RESETS_PER_DAY = 5
const DAY_MS = 24 * 60 * 60 * 1000

function siteUrl(): string {
  return (process.env.SITE_URL ?? '').replace(/\/+$/, '')
}

/**
 * A reset link for `email`, unless the limits say not yet. Never throws for a
 * limit or a deployment with no sender: the page says the same thing either
 * way, and an error here would tell a stranger the address has an account.
 */
export const requestPasswordReset = internalMutation({
  args: {
    userId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    token: v.string(),
  },
  handler: async (ctx, { userId, email: rawEmail, name, token }) => {
    const email = rawEmail.trim().toLowerCase()
    if (!accountEmailFrom()) {
      console.warn(
        'Password reset asked for, but RESEND_ACCOUNT_FROM_EMAIL or RESEND_API_KEY is not set on this deployment.',
      )
      return { queued: false as const, reason: 'notConfigured' as const }
    }
    const now = Date.now()
    const recent = await ctx.db
      .query('accountEmails')
      .withIndex('by_email_and_createdAt', (q) =>
        q.eq('email', email).gte('createdAt', now - DAY_MS),
      )
      .collect()
    const resets = recent.filter((row) => row.kind === 'passwordReset')
    const last = resets.at(-1)
    if (
      resets.length >= RESETS_PER_DAY ||
      (last && now - last.createdAt < RESET_MIN_GAP_MS)
    ) {
      return { queued: false as const, reason: 'limit' as const }
    }
    const url = `${siteUrl()}/reset-password?token=${encodeURIComponent(token)}`
    await queue(ctx, { kind: 'passwordReset', userId, email, name, url })
    return { queued: true as const }
  },
})

/** "Your password was changed", after a reset went through. */
export const passwordChanged = internalMutation({
  args: {
    userId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, { userId, email, name }) => {
    if (!accountEmailFrom()) return
    await queue(ctx, {
      kind: 'passwordChanged',
      userId,
      email: email.trim().toLowerCase(),
      name,
      url: `${siteUrl()}/login`,
    })
  },
})

async function queue(
  ctx: MutationCtx,
  {
    kind,
    userId,
    email,
    name,
    url,
    xero,
  }: {
    kind: Doc<'accountEmails'>['kind']
    userId: string
    email: string
    name?: string
    url: string
    xero?: Infer<typeof xeroFacts>
  },
) {
  const emailId = await ctx.db.insert('accountEmails', {
    kind,
    userId,
    email,
    status: 'queued',
    createdAt: Date.now(),
  })
  await ctx.scheduler.runAfter(0, internal.accountEmails.send, {
    emailId,
    ...(name ? { name } : {}),
    url,
    ...(xero ? { xero } : {}),
  })
}

/** What a "Xero connected" email says (lib/accountEmail.ts
 * `XeroConnectedFacts`), and for the owner's, who connected it. Names, not
 * secrets: they travel in the send's arguments like the reset link, and the
 * row keeps only who it went to. */
const xeroFacts = v.object({
  orgName: v.string(),
  businessName: v.string(),
  when: v.string(),
  mine: v.boolean(),
  memberName: v.optional(v.string()),
})

/**
 * A member's sign-in name and address, or null when the account can't be
 * read (deleted, or the component down: the connect still stands).
 *
 * Read from Better Auth's own table rather than through `authComponent`, so
 * this module never loads convex/auth.ts: that reads its switches
 * (`AUTH_BREACH_CHECK` and the rest) once, when it loads.
 */
async function accountOf(
  ctx: MutationCtx,
  userId: string,
): Promise<{ email: string; name?: string } | null> {
  try {
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: userId }],
    })) as { email?: string; name?: string } | null
    if (!user?.email) return null
    return { email: user.email, ...(user.name ? { name: user.name } : {}) }
  } catch (error) {
    console.error(`account lookup failed for ${userId}`, error)
    return null
  }
}

/**
 * A Xero organisation was just connected (convex/xero.ts `finish`, a first
 * connect, not a reconnect of the same one): tell whoever's account did it,
 * and — when it is a member's own organisation, which gets every client in
 * the business — the owner too. Connecting needs no two-step sign-in
 * (lib/xeroConfig.ts `xeroTwoStepRequired`), so these are what make a
 * connect nobody meant visible within minutes. Queued in the connect's own
 * transaction; nothing on a deployment that can't send account email.
 */
export async function queueXeroConnected(
  ctx: MutationCtx,
  {
    business,
    connection,
    member,
    memberName,
    at,
  }: {
    business: Doc<'businesses'>
    connection: Doc<'xeroConnections'>
    /** Whoever connected it. */
    member: Doc<'memberships'>
    /** How the Team screen names them. */
    memberName: string
    at: number
  },
): Promise<void> {
  if (!accountEmailFrom()) return
  const mine = connection.kind === 'member'
  const facts = {
    orgName: connection.tenantName,
    businessName: business.name,
    when: emailWhen(at, business.timezone),
    mine,
  }
  const settings = `${siteUrl()}/${business.slug}/settings`

  const self = await accountOf(ctx, member.userId)
  if (self) {
    await queue(ctx, {
      kind: 'xeroConnected',
      userId: member.userId,
      email: self.email.trim().toLowerCase(),
      name: self.name,
      url: `${settings}/${mine ? 'my-xero' : 'xero'}`,
      xero: facts,
    })
  }
  if (!mine) return

  const owner = (
    await ctx.db
      .query('memberships')
      .withIndex('by_business', (q) => q.eq('businessId', business._id))
      .collect()
  ).find((row) => row.role === 'owner' && row.status === 'active')
  if (!owner || owner._id === member._id) return
  const ownerAccount = await accountOf(ctx, owner.userId)
  if (!ownerAccount) return
  await queue(ctx, {
    kind: 'memberXeroConnected',
    userId: owner.userId,
    email: ownerAccount.email.trim().toLowerCase(),
    name: ownerAccount.name,
    url: `${settings}/team`,
    xero: { ...facts, memberName },
  })
}

export const forSending = internalQuery({
  args: { emailId: v.id('accountEmails') },
  handler: async (ctx, { emailId }) => ctx.db.get(emailId),
})

export const settle = internalMutation({
  args: {
    emailId: v.id('accountEmails'),
    status: v.union(v.literal('sent'), v.literal('failed')),
    providerMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { emailId, status, providerMessageId, error }) => {
    await ctx.db.patch(emailId, {
      status,
      ...(providerMessageId ? { providerMessageId } : {}),
      ...(error ? { error: error.slice(0, 500) } : {}),
      ...(status === 'sent' ? { sentAt: Date.now() } : {}),
    })
  },
})

/** Sends one queued account email through Resend. */
export const send = internalAction({
  args: {
    emailId: v.id('accountEmails'),
    name: v.optional(v.string()),
    url: v.string(),
    xero: v.optional(xeroFacts),
  },
  handler: async (ctx, { emailId, name, url, xero }) => {
    const row = await ctx.runQuery(internal.accountEmails.forSending, {
      emailId,
    })
    if (!row || row.status !== 'queued') return
    const from = accountEmailFrom()
    const apiKey = process.env.RESEND_API_KEY
    if (!from || !apiKey) {
      await ctx.runMutation(internal.accountEmails.settle, {
        emailId,
        status: 'failed',
        error: 'Account email is not set up on this deployment',
      })
      return
    }
    // The app's own address, which serves its icon; none on a deployment
    // without one, and the email goes without the mark.
    const markUrl = siteUrl() ? `${siteUrl()}${APP_MARK_PATH}` : undefined
    const content = contentOf(row.kind, { name, url, markUrl, xero })
    if (!content) {
      await ctx.runMutation(internal.accountEmails.settle, {
        emailId,
        status: 'failed',
        error: `Nothing to say for a ${row.kind} email`,
      })
      return
    }
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // One email per row, however many times this is retried.
          'Idempotency-Key': `account-email-${emailId}`,
        },
        body: JSON.stringify({
          from: `PestM8 <${from}>`,
          to: [row.email],
          subject: content.subject,
          html: content.html,
          text: content.text,
        }),
      })
      if (!response.ok) {
        await ctx.runMutation(internal.accountEmails.settle, {
          emailId,
          status: 'failed',
          error: (await response.text()).slice(0, 500),
        })
        return
      }
      const body = (await response.json()) as { id?: string }
      await ctx.runMutation(internal.accountEmails.settle, {
        emailId,
        status: 'sent',
        ...(body.id ? { providerMessageId: body.id } : {}),
      })
    } catch (error) {
      await ctx.runMutation(internal.accountEmails.settle, {
        emailId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
})

/** The email a row's kind is, from what its send was given; null when a
 * Xero one was queued without its facts (never, but not sent blank). */
function contentOf(
  kind: Doc<'accountEmails'>['kind'],
  {
    name,
    url,
    markUrl,
    xero,
  }: {
    name?: string
    url: string
    markUrl?: string
    xero?: Infer<typeof xeroFacts>
  },
) {
  switch (kind) {
    case 'passwordReset':
      return passwordResetEmail({ name, url, markUrl })
    case 'passwordChanged':
      return passwordChangedEmail({ name, signInUrl: url, markUrl })
    case 'xeroConnected':
      return xero
        ? xeroConnectedEmail({ name, facts: xero, settingsUrl: url, markUrl })
        : null
    case 'memberXeroConnected':
      return xero?.memberName
        ? memberXeroConnectedEmail({
            name,
            memberName: xero.memberName,
            facts: xero,
            teamUrl: url,
            markUrl,
          })
        : null
  }
}
