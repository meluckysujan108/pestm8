import { useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import { ConfirmDialog } from './ConfirmDialog'
import { LOGO_NOTICE_COPY, useLogoUpload } from './useLogoUpload'
import { LINK_BUTTON_COMPACT } from '#/components/primitives/buttons'
import { Bone } from '#/components/shell/Pending'
import { useHydrated } from '#/lib/useHydrated'
import type { LogoSlot } from './useLogoUpload'
import type { Id } from '../../../convex/_generated/dataModel'

/**
 * The letterhead's logos, as rows of Settings → Business → Letterhead: the
 * logo every report prints and every report email heads with, and — once
 * there is one — its optional version with light lettering, for emails read in
 * dark mode.
 *
 * Each is shown large and at its own shape, on what it will be seen on: the
 * logo on paper, the other on the dark email's card. Without a dark version,
 * that tile shows what dark mode does instead — the logo on its white card —
 * so what is on offer can be seen rather than only read about.
 */
export function LetterheadLogos({
  businessId,
  logoUrl,
  logoOnDarkUrl,
}: {
  businessId: Id<'businesses'>
  /** Live (`getBySlug`): a new logo shows the moment it lands. */
  logoUrl: string | null
  /** From `reportSettings`; undefined until it answers. */
  logoOnDarkUrl: string | null | undefined
}) {
  return (
    <>
      <LogoRow which="logo" businessId={businessId} url={logoUrl} />
      {/* Only with a logo to be a version of: an email swaps one for the
          other, and has nothing to swap without the first. */}
      {logoUrl && (
        <LogoRow
          which="logoOnDark"
          businessId={businessId}
          url={logoOnDarkUrl}
          fallbackUrl={logoUrl}
        />
      )}
    </>
  )
}

const WORDS = {
  logo: {
    title: 'Logo',
    hint: 'Prints on every report and heads its emails. A PNG with a clear background looks best.',
    add: 'Add logo',
    change: 'Change logo',
    alt: 'Business logo',
    removeTitle: 'Remove the logo?',
    removeBody:
      'New reports and emails go out without one. A report already locked keeps the logo it was locked with.',
    keep: 'Keep logo',
  },
  logoOnDark: {
    title: 'Logo for dark backgrounds (optional)',
    hint: 'Shown when a client reads your email in dark mode. Use a version with white lettering.',
    add: 'Add',
    change: 'Change',
    alt: 'Logo for dark backgrounds',
    removeTitle: 'Remove the logo for dark backgrounds?',
    removeBody:
      'Emails read in dark mode show your logo on its white card instead.',
    keep: 'Keep it',
  },
} as const

function LogoRow({
  which,
  businessId,
  url,
  fallbackUrl,
}: {
  which: LogoSlot
  businessId: Id<'businesses'>
  /** Undefined while it is still being read. */
  url: string | null | undefined
  /** The logo a dark email shows on its card when this one is missing. */
  fallbackUrl?: string
}) {
  const hydrated = useHydrated()
  const words = WORDS[which]
  const { busy, notice, upload, remove } = useLogoUpload(businessId, which)
  const [confirming, setConfirming] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const pick = useRef<HTMLButtonElement>(null)
  const trash = useRef<HTMLButtonElement>(null)
  const onDark = which === 'logoOnDark'
  const shown =
    busy === 'uploading' ? 'Uploading…' : url ? words.change : words.add
  // The dark row's words are short beside its title; a screen reader hears
  // what they change, starting with the words shown.
  const pickLabel =
    onDark && busy !== 'uploading'
      ? `${shown} logo for dark backgrounds`
      : undefined

  return (
    <div className="px-3.5 py-3">
      <p className="text-body text-ink">{words.title}</p>

      {/* Pinned to what it is seen on: paper for the logo, the dark email's
          card for its light-lettered version. */}
      <div
        data-theme={onDark ? 'dark' : 'light'}
        className={`mt-2 flex h-20 items-center justify-center overflow-hidden rounded-lg border border-hairline px-4 ${onDark ? 'bg-surface' : 'bg-paper'}`}
      >
        {url === undefined ? (
          <Bone className="h-10 w-40" />
        ) : url ? (
          <img
            src={url}
            alt={words.alt}
            className="h-14 w-auto max-w-full object-contain"
          />
        ) : onDark && fallbackUrl ? (
          <span className="flex max-w-full rounded-sm bg-paper p-2">
            <img
              src={fallbackUrl}
              alt=""
              className="h-10 w-auto max-w-full object-contain"
            />
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-caption text-muted">
            <ImagePlus aria-hidden size={16} strokeWidth={2} />
            No logo yet
          </span>
        )}
      </div>

      <p className="mt-2 text-caption text-muted">
        {words.hint}
        {onDark &&
          url === null &&
          ' Without one, your logo shows on a white card, as above.'}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <button
          ref={pick}
          type="button"
          disabled={!hydrated || busy !== null || url === undefined}
          onClick={() => input.current?.click()}
          aria-label={pickLabel}
          className={`${LINK_BUTTON_COMPACT} px-3.5`}
        >
          {shown}
        </button>
        {url && (
          <button
            ref={trash}
            type="button"
            disabled={!hydrated || busy !== null}
            onClick={() => setConfirming(true)}
            aria-label={`Remove ${onDark ? 'logo for dark backgrounds' : 'logo'}`}
            className="ml-auto flex size-11 shrink-0 items-center justify-center rounded-full text-red outline-none transition active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue disabled:opacity-40"
          >
            <Trash2 aria-hidden size={19} strokeWidth={1.7} />
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          data-logo-input={which}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void upload(file)
          }}
        />
      </div>

      {notice && (
        <p
          role={notice === 'darkBackground' ? 'status' : 'alert'}
          className="mt-2 text-caption text-amber-ink"
        >
          {LOGO_NOTICE_COPY[notice]}
        </p>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={words.removeTitle}
        body={words.removeBody}
        cancel={words.keep}
        confirm="Remove"
        onConfirm={() => void remove()}
        returnFocus={(removed) => (removed ? pick.current : trash.current)}
      />
    </div>
  )
}
