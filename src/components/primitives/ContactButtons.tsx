import { useEffect, useState } from 'react'
import { Mail, MapPin, MessageSquareText, Phone } from 'lucide-react'
import { HoldButton } from './HoldButton'
import { mapsUrl, openMapTab } from '#/lib/maps'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type ContactAction = 'call' | 'text' | 'email' | 'map'

const DEFAULT_ACTIONS: ReadonlyArray<ContactAction> = ['call', 'text', 'email']

const TILE = {
  // The sheets' tiles: icon over label, room to spare.
  sheet:
    'flex flex-1 flex-col items-center justify-center gap-1 rounded-xl bg-surface-2 py-2.5 text-caption font-semibold text-blue',
  // A job card's: three across a phone, each still a full 44pt tall to hit
  // with a glove. px-2, not px-3: Call, Text and Email fit side by side on a
  // 320pt screen.
  card: 'flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl bg-surface-2 px-2 text-caption font-semibold text-blue',
} as const

/** The job card's corner Map: the same tile, sized to its label. */
const CORNER_TILE =
  'flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-surface-2 px-3 text-caption font-semibold text-blue'

/**
 * A tile's icon and word. The card's is one row; the sheets' stacks the icon
 * over the word.
 */
function tileLabel(
  variant: 'sheet' | 'card',
  Icon: LucideIcon,
  caption: string,
): ReactNode {
  return variant === 'card' ? (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon size={16} strokeWidth={1.7} aria-hidden className="shrink-0" />
      <span className="truncate">{caption}</span>
    </span>
  ) : (
    <>
      <Icon size={17} strokeWidth={1.7} aria-hidden />
      {caption}
    </>
  )
}

function placeOf(address: { addressLine?: string; suburb?: string }): string {
  return [address.addressLine, address.suburb]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(', ')
}

/**
 * Hold-to-call/text/email row, shared by ClientSheet.tsx (a client's own
 * line, and once per named contact), JobDetailSheet.tsx (a job's client) and
 * the job card, so the hold, its labels and its guards cannot drift apart.
 * The sheets use the full-width `sheet` buttons; the card, compact `card`
 * ones. Text is offered wherever Call is, since both reach the same number —
 * unless `show` narrows the set. Renders nothing if none of the requested
 * actions has the data it needs.
 *
 * Every action is a hold (HoldButton): a phone on site gets pocketed and
 * brushed, and each of these reaches a client or leaves the app. Map was a
 * plain link until the owner asked for it to be held too; it lives in its own
 * `MapHoldButton` because the card puts it in the corner, not in this row.
 */
export function ContactButtons({
  name,
  phone,
  email,
  address,
  show = DEFAULT_ACTIONS,
  toBook = false,
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
  /** For a visit nobody has agreed to yet: the call, text or email is to book
   * it, and each says so to assistive technology. The card says it once, in
   * a line above the row, since "Call to book" three times does not fit. */
  toBook?: boolean
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
  const label = (Icon: LucideIcon, caption: string) =>
    tileLabel(variant, Icon, caption)
  // Each accessible name starts with the word on the button (WCAG 2.5.3), so
  // "tap Call" works for someone driving the phone by voice.
  const purpose = (verb: string) =>
    toBook ? `${verb} to book: ${name}` : `${verb} ${name}`

  return (
    <div className="flex gap-2">
      {call && (
        <HoldButton
          ariaLabel={purpose('Call')}
          onComplete={() => {
            window.location.href = `tel:${phone}`
          }}
          hint={label(Phone, 'Hold')}
          className={tile}
          inScrollingList={inScrollingList}
        >
          {label(Phone, 'Call')}
        </HoldButton>
      )}
      {text && (
        <HoldButton
          ariaLabel={purpose('Text')}
          onComplete={() => {
            window.location.href = `sms:${phone}`
          }}
          hint={label(MessageSquareText, 'Hold')}
          className={tile}
          inScrollingList={inScrollingList}
        >
          {label(MessageSquareText, 'Text')}
        </HoldButton>
      )}
      {mail && (
        <HoldButton
          ariaLabel={purpose('Email')}
          onComplete={() => {
            window.location.href = `mailto:${email}`
          }}
          hint={label(Mail, 'Hold')}
          className={tile}
          inScrollingList={inScrollingList}
        >
          {label(Mail, 'Email')}
        </HoldButton>
      )}
      {map !== null && address && (
        <MapHoldButton
          address={address}
          className={tile}
          variant={variant}
          inScrollingList={inScrollingList}
        />
      )}
    </div>
  )
}

/** How long the fallback link stays, after a map the browser would not open. */
const FALLBACK_MS = 10_000

/**
 * Hold to open the address in the maps app, in a new tab.
 *
 * If the browser refuses the tab anyway, the button becomes a plain "Open"
 * link for a few seconds: a tap on a real link is never blocked, and opening
 * a map reaches nobody, so one deliberate tap is enough the second time. The
 * word is true either way, since an installed iPhone app can report a block
 * when the map did in fact open. Short, so the corner does not grow over the
 * client's name.
 */
export function MapHoldButton({
  address,
  className = CORNER_TILE,
  variant = 'card',
  inScrollingList = true,
}: {
  address: { addressLine?: string; suburb?: string; postcode?: string }
  className?: string
  variant?: 'sheet' | 'card'
  inScrollingList?: boolean
}) {
  const url = mapsUrl(address)
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    if (!blocked) return
    const timer = window.setTimeout(() => setBlocked(false), FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [blocked])

  if (url === null) return null
  const place = placeOf(address) || 'the address'

  if (blocked) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open map of ${place}`}
        onClick={() => setBlocked(false)}
        className={className}
      >
        {tileLabel(variant, MapPin, 'Open')}
      </a>
    )
  }

  return (
    <HoldButton
      ariaLabel={`Map of ${place}`}
      onComplete={() => {
        if (!openMapTab(url)) setBlocked(true)
      }}
      hint={tileLabel(variant, MapPin, 'Hold')}
      className={className}
      inScrollingList={inScrollingList}
    >
      {tileLabel(variant, MapPin, 'Map')}
    </HoldButton>
  )
}
