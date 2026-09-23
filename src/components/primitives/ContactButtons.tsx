import { Mail, MapPin, MessageSquareText, Phone } from 'lucide-react'
import { HoldButton } from './HoldButton'
import { mapsUrl } from '#/lib/maps'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type ContactAction = 'call' | 'text' | 'email' | 'map'

const DEFAULT_ACTIONS: ReadonlyArray<ContactAction> = ['call', 'text', 'email']

const TILE = {
  // The sheets' tiles: icon over label, room to spare.
  sheet:
    'flex flex-1 flex-col items-center justify-center gap-1 rounded-xl bg-surface-2 py-2.5 text-caption font-semibold text-blue',
  // A job card's: one short row, still a full 44pt tall to hit with a glove.
  card: 'flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-surface-2 px-3 text-caption font-semibold text-blue',
} as const

/**
 * Hold-to-call/text/email row, shared by ClientSheet.tsx (a client's own
 * line, and once per named contact), JobDetailSheet.tsx (a job's client) and
 * the job card, so they stay pixel-identical rather than drifting. Text is
 * offered wherever Call is, since both dial the same number — unless `show`
 * narrows the set. Renders nothing if none of the requested actions has the
 * data it needs.
 *
 * Map is not a hold: opening a map cannot reach anyone, so there is nothing
 * to guard against. It is a plain link that opens a new browsing context —
 * navigating this window to it would unload the installed app, and a tab
 * opened from a real tap is what keeps the user in it.
 */
export function ContactButtons({
  name,
  phone,
  email,
  address,
  show = DEFAULT_ACTIONS,
  callToBook = false,
  variant = 'sheet',
}: {
  name: string
  phone?: string
  email?: string
  /** Where Map points. Map appears only when `show` asks for it. */
  address?: { addressLine?: string; suburb?: string; postcode?: string }
  /** Which actions to offer, of those the data allows. Defaults to what the
   * sheets have always shown: Call, Text and Email. */
  show?: ReadonlyArray<ContactAction>
  /** For a visit nobody has agreed to yet: the call is to book it, and the
   * button says so rather than reading as a call about arranged work. */
  callToBook?: boolean
  /** `card` for a job card in a scrolling list: a compact row, and holds
   * that let the list scroll (see HoldButton `inScrollingList`). */
  variant?: 'sheet' | 'card'
}) {
  const call = show.includes('call') && Boolean(phone)
  const text = show.includes('text') && Boolean(phone)
  const mail = show.includes('email') && Boolean(email)
  const map = show.includes('map') && address ? mapsUrl(address) : null

  if (!call && !text && !mail && map === null) return null

  const tile = TILE[variant]
  const inScrollingList = variant === 'card'

  /**
   * On touch, HoldButton wraps its children in a span of its own, and icons
   * are block-level — so a row tile's icon would stack over its label on a
   * phone and sit beside it on a desktop. The card's label is one inline-flex
   * row that lays out the same inside either. The sheets' children stay
   * exactly as they were.
   */
  const label = (Icon: LucideIcon, caption: string): ReactNode =>
    variant === 'card' ? (
      <span className="inline-flex items-center gap-1.5">
        <Icon size={16} strokeWidth={1.7} aria-hidden />
        {caption}
      </span>
    ) : (
      <>
        <Icon size={17} strokeWidth={1.7} />
        {caption}
      </>
    )
  const place = [address?.addressLine, address?.suburb]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ')

  return (
    <div className="flex gap-2">
      {call && (
        <HoldButton
          // Each name starts with the words on the button (WCAG 2.5.3), so
          // "tap Call to book" works for someone driving the phone by voice.
          ariaLabel={callToBook ? `Call to book: ${name}` : `Call ${name}`}
          onComplete={() => {
            window.location.href = `tel:${phone}`
          }}
          className={tile}
          inScrollingList={inScrollingList}
        >
          {label(Phone, callToBook ? 'Call to book' : 'Call')}
        </HoldButton>
      )}
      {text && (
        <HoldButton
          ariaLabel={`Text ${name}`}
          onComplete={() => {
            window.location.href = `sms:${phone}`
          }}
          className={tile}
          inScrollingList={inScrollingList}
        >
          {label(MessageSquareText, 'Text')}
        </HoldButton>
      )}
      {mail && (
        <HoldButton
          ariaLabel={`Email ${name}`}
          onComplete={() => {
            window.location.href = `mailto:${email}`
          }}
          className={tile}
          inScrollingList={inScrollingList}
        >
          {label(Mail, 'Email')}
        </HoldButton>
      )}
      {map !== null && (
        <a
          href={map}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Map of ${place || 'the address'}`}
          className={tile}
        >
          {label(MapPin, 'Map')}
        </a>
      )}
    </div>
  )
}
