/**
 * What kind of device this is, as far as its browser says. Its own module,
 * with nothing else in it, because the install steps (lib/installMethod.ts)
 * need it on every page, and every page should not carry the PDF helpers it
 * used to live beside (lib/pdfFiles.ts, which still re-exports it).
 */

/** What the platform check reads, split out so it can be tested. */
export type DeviceHints = {
  userAgent: string
  platform: string
  maxTouchPoints: number
}

/**
 * An iPhone, iPod touch or iPad — including an iPad asking for desktop sites,
 * which it does by default from iPadOS 13 on and which then reports itself
 * as a Mac ("Macintosh" in the user agent, "MacIntel" as the platform). What
 * gives it away is the touch screen: no Mac has one, so a "Mac" with more
 * than one touch point is an iPad. Chrome and Firefox on iOS are WebKit
 * underneath and say "iPhone" or "iPad" like Safari does, so they are covered
 * too — and they share its rules about downloads and the share sheet.
 */
export function isAppleTouch(hints: DeviceHints): boolean {
  if (/\b(iPhone|iPad|iPod)\b/.test(hints.userAgent)) return true
  if (/^(iPhone|iPad|iPod)/.test(hints.platform)) return true
  const saysMac =
    /^Mac/.test(hints.platform) || /\bMacintosh\b/.test(hints.userAgent)
  return saysMac && hints.maxTouchPoints > 1
}
