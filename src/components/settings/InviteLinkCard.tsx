import { useState } from 'react'
import { Check, Copy, Share2 } from 'lucide-react'
import {
  NEUTRAL_BUTTON_COMPACT,
  SECONDARY_BUTTON_COMPACT,
} from '#/components/primitives/buttons'

/**
 * Shown once, immediately after the link is minted. There is no "copy it
 * later": the server keeps only a hash, so a lost link is replaced rather
 * than looked up. Done, under it, closes it for good.
 */
export function InviteLinkCard({
  email,
  url,
  businessName,
  inviterName,
}: {
  email: string
  url: string
  /** Named in the text, so it reads as from someone they know. */
  businessName?: string
  inviterName?: string
}) {
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator

  const smsBody = inviteMessage({ url, businessName, inviterName })

  return (
    <div>
      <p className="text-body font-semibold text-ink">Send this to {email}</p>
      <p className="mt-0.5 text-caption text-muted">
        Shown once. Works for 3 days, for that address only.
      </p>

      <p className="mt-3 truncate rounded-xl bg-surface-2 px-3 py-2.5 font-mono text-caption text-ink-2">
        {url}
      </p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }}
          className={`${SECONDARY_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2`}
        >
          {copied ? (
            <Check size={16} strokeWidth={2.2} />
          ) : (
            <Copy size={16} strokeWidth={2} />
          )}
          {copied ? 'Copied' : 'Copy link'}
        </button>

        {canShare ? (
          <button
            type="button"
            onClick={() => {
              void navigator.share({ text: smsBody }).catch(() => {})
            }}
            className={`${NEUTRAL_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2`}
          >
            <Share2 size={16} strokeWidth={2} />
            Share
          </button>
        ) : (
          <a
            href={`sms:?&body=${encodeURIComponent(smsBody)}`}
            className={`${NEUTRAL_BUTTON_COMPACT} flex flex-1 items-center justify-center gap-2`}
          >
            <Share2 size={16} strokeWidth={2} />
            Text it
          </a>
        )}
      </div>
    </div>
  )
}

/**
 * The text the link goes out in. Who is asking and for which business, when
 * known: "Here's your PestM8 invite" from an unknown number reads like spam,
 * and a technician should know whose team they are joining before they tap.
 */
export function inviteMessage({
  url,
  businessName,
  inviterName,
}: {
  url: string
  businessName?: string
  inviterName?: string
}): string {
  const business = businessName?.trim()
  const inviter = inviterName?.trim()
  if (business && inviter) {
    return `${inviter} has invited you to join ${business} on PestM8. Set up your account here: ${url}`
  }
  if (business) {
    return `You’re invited to join ${business} on PestM8. Set up your account here: ${url}`
  }
  return `Here’s your PestM8 invite: ${url}`
}
