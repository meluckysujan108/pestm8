/**
 * What a send's outcome reads as, on the finished report's page.
 *
 * Kept apart from the components so the words are tested on their own:
 * `ReportEmails` lists each send with them and `ReportActivity` repeats the
 * failures, and the two must never disagree about what happened.
 */

/**
 * The words a stored failure carries, as the page says them now.
 *
 * A delivery row and its audit entry keep the sentence written when the send
 * failed (`convex/email.ts`, `convex/lib/sendLimit.ts`, `convex/reports.ts`),
 * and until 30 Sept 2026 those pointed at the report's tabs — "Open the PDF
 * tab", "from the Email tab". The tabs are gone and the rows are not, so the
 * directions are put right where they are read, for old rows and new alike.
 */
export function withoutTabs(text: string): string {
  return text
    .replace('Open the PDF tab, then', 'Open the PDF, then')
    .replace(
      'Share it from the PDF tab instead.',
      'Use Share on the report instead.',
    )
    .replace(/ from (?:the|its) Email tab/, '')
}

export type DeliveryState = {
  status: 'queued' | 'sent' | 'failed' | 'bounced'
  error?: string
  waitingForEmailSetup: boolean
}

/**
 * How one send reads: a word for where it got to, what to do next when it
 * did not go, and whether it is a warning.
 *
 * `stuck` is a send still queued well after it should have gone (its render
 * failed, or it was never scheduled): a spinner beside it would be a promise.
 */
export function deliveryState(
  row: DeliveryState,
  stuck: boolean,
): {
  word: string
  next: string | null
  warn: boolean
  sending: boolean
  /** Worth a "Send again": it did not go, and another try might. */
  retry: boolean
} {
  switch (row.status) {
    case 'sent':
      return {
        word: 'Sent',
        next: null,
        warn: false,
        sending: false,
        retry: false,
      }
    case 'queued':
      if (row.waitingForEmailSetup) {
        return {
          word: 'Not sent',
          next: 'Email isn’t set up for this business yet. Share the PDF instead.',
          warn: true,
          sending: false,
          retry: false,
        }
      }
      return stuck
        ? {
            word: 'Not sent',
            next: 'It didn’t go. Send it again.',
            warn: true,
            sending: false,
            retry: true,
          }
        : {
            word: 'Sending…',
            next: null,
            warn: false,
            sending: true,
            retry: false,
          }
    case 'bounced':
      return {
        word: 'Bounced',
        next: row.error
          ? withoutTabs(row.error)
          : 'The address didn’t take it. Check it, then send it again.',
        warn: true,
        sending: false,
        retry: true,
      }
    case 'failed':
      // Refused by an owner before approval was retired (29 Sept 2026): what
      // happened, rather than a nudge to send it again to an address an owner
      // said no to.
      if (row.error === 'Not approved') {
        return {
          word: 'Not approved',
          next: 'An owner didn’t approve it.',
          warn: true,
          sending: false,
          retry: false,
        }
      }
      return {
        word: 'Failed',
        next: row.error
          ? withoutTabs(row.error)
          : 'Could not send the email. Send it again.',
        warn: true,
        sending: false,
        retry: true,
      }
  }
}
