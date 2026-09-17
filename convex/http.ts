import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { internal } from './_generated/api'
import { authComponent, createAuth } from './auth'
import { verifySvix } from './lib/svix'

const http = httpRouter()

authComponent.registerRoutes(http, createAuth)

/**
 * What Resend tells us after the fact.
 *
 * "Sent" only ever meant "the provider accepted it", and on a compliance
 * record the gap matters: a report the client never received is not a
 * delivered report, however green the row looks. A bounce or a spam complaint
 * arrives here minutes later and moves the delivery — and with it the
 * library's Sent bucket, which would otherwise keep saying the client has it.
 *
 * Set the endpoint in Resend against this deployment's `.site` origin, and
 * `RESEND_WEBHOOK_SECRET` with `npx convex env set`. Until both exist this
 * route refuses everything, which is the right answer for an unauthenticated
 * endpoint that writes.
 */
http.route({
  path: '/resend/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET
    // 404, not 401: an endpoint that is not configured should not confirm it
    // exists to whoever is probing for it.
    if (!secret) return new Response('Not found', { status: 404 })

    // Read once, as text: the signature is over the exact bytes sent, so
    // parsing first and re-serialising would verify a different message.
    const body = await request.text()
    const valid = await verifySvix({
      secret,
      headers: {
        id: request.headers.get('svix-id'),
        timestamp: request.headers.get('svix-timestamp'),
        signature: request.headers.get('svix-signature'),
      },
      body,
    })
    if (!valid) return new Response('Bad signature', { status: 401 })

    const event = JSON.parse(body) as {
      type?: string
      data?: { email_id?: string; reason?: string }
    }
    const messageId = event.data?.email_id
    const kind = EVENTS[event.type ?? '']
    // Acknowledged, not refused: an event type we do not act on is Resend
    // working correctly, and a non-2xx would have it retry forever.
    if (!messageId || !kind) return new Response('OK', { status: 200 })

    await ctx.runMutation(internal.deliveries.recordProviderEvent, {
      providerMessageId: messageId,
      event: kind,
      ...(event.data?.reason ? { detail: event.data.reason.slice(0, 500) } : {}),
    })

    return new Response('OK', { status: 200 })
  }),
})

/**
 * The three that change what a delivery means. The rest are noise here, and
 * the `| undefined` is the point of the type: a lookup against a provider's
 * event vocabulary misses far more often than it hits.
 */
const EVENTS: Record<
  string,
  'delivered' | 'bounced' | 'complained' | undefined
> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
}

export default http
