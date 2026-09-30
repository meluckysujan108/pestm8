import type { ErrorCopy } from '#/components/forms/describeError'

/**
 * What deleting a report says, in one place for the Reports list, its Deleted
 * tab and the report's own page.
 *
 * A draft is work in progress, and its words are as they always were. A
 * finalised report is a signed record, which only the owner may delete
 * (`reports.softDelete`), and the confirm says the three things that differ:
 * every version of its number goes with it, what was emailed is not
 * recalled, and it may be a record the law wants kept — with a correction as
 * the way to fix a report that is only wrong.
 */

/** A report as a list row or its page knows it. */
export type DeletableReport = {
  status: string
  templateName: string
  clientName: string
  suburb: string
  reportNumber?: number
  version?: number
  /** A later version of its number has been issued. */
  replaced?: boolean
  /** A correction of it is being drafted, which goes with it. */
  correcting?: boolean
}

export type DeleteWords = {
  title: string
  body: string
  /** Said apart from `body`, on a signed report only. */
  caution?: string
  confirm: string
  cancel: string
  failed: ErrorCopy
}

/** "#12", or nothing for a report locked before numbers existed. */
function numberOf(report: DeletableReport): string | null {
  return report.reportNumber !== undefined ? `#${report.reportNumber}` : null
}

/** "Service Report for J. Nguyen, Bayswater" — as much of it as is known. */
export function reportName(report: DeletableReport): string {
  const client = report.clientName ? ` for ${report.clientName}` : ''
  const suburb = report.suburb ? `, ${report.suburb}` : ''
  return `${report.templateName}${client}${suburb}`
}

/** One of several versions of its number, which a delete takes together. */
function hasVersions(report: DeletableReport): boolean {
  return (report.version ?? 1) > 1 || report.replaced === true
}

function isDraft(report: DeletableReport): boolean {
  return report.status === 'draft'
}

const OWNER_ONLY =
  'only the business owner can delete a finalised report. Ask them to.'

/** Moving a report to Deleted. */
export function deleteWords(report: DeletableReport): DeleteWords {
  if (isDraft(report)) {
    return {
      title: 'Delete this draft?',
      body: `${reportName(report)}. It waits in Deleted for 30 days, with its photos, then it is gone.`,
      confirm: 'Delete draft',
      cancel: 'Keep draft',
      failed: {
        default: 'Could not delete the draft. Check your signal and try again.',
      },
    }
  }

  const number = numberOf(report)
  const versions = hasVersions(report)
  const correcting = report.correcting === true
  const goesWith = versions
    ? `Every version of ${number ?? 'it'} goes with it${correcting ? ', and the correction being drafted' : ''}.`
    : correcting
      ? 'The correction being drafted goes with it.'
      : null
  return {
    title: number ? `Delete report ${number}?` : 'Delete this report?',
    body: [
      `${reportName(report)}.`,
      goesWith,
      'It waits in Deleted for 30 days, then it’s gone. Anything already emailed stays in the inboxes it went to.',
    ]
      .filter(Boolean)
      .join(' '),
    caution:
      'A signed report can be a record the law requires you to keep — if it only has a mistake, issue a correction instead.',
    confirm: 'Delete report',
    cancel: 'Keep report',
    failed: {
      NO_ACCESS: `Could not delete: ${OWNER_ONLY}`,
      default: 'Could not delete the report. Check your signal and try again.',
    },
  }
}

/** Deleting for good, from Deleted. */
export function purgeWords(report: DeletableReport): DeleteWords {
  if (isDraft(report)) {
    return {
      title: 'Delete this draft for good?',
      body: 'The draft and its photos are gone, and it can’t be undone. Those photos are evidence that somebody stood somewhere and took them.',
      confirm: 'Delete for good',
      cancel: 'Keep it',
      failed: {
        offline:
          'Could not delete the draft: this device is offline. Try again when you have signal.',
        default: 'Could not delete the draft. Check your signal and try again.',
      },
    }
  }

  const number = numberOf(report)
  return {
    title: number
      ? `Delete report ${number} for good?`
      : 'Delete this report for good?',
    body: [
      `${
        hasVersions(report)
          ? `Every version of ${number ?? 'it'}, with its PDFs, photos and email history, is gone`
          : 'The report, with its PDF, photos and email history, is gone'
      }, and it can’t be undone.`,
      report.correcting ? 'So is the correction being drafted.' : null,
      'Anything already emailed stays in the inboxes it went to.',
    ]
      .filter(Boolean)
      .join(' '),
    confirm: 'Delete for good',
    cancel: 'Keep it',
    failed: {
      offline:
        'Could not delete the report: this device is offline. Try again when you have signal.',
      NO_ACCESS: `Could not delete: ${OWNER_ONLY}`,
      default: 'Could not delete the report. Check your signal and try again.',
    },
  }
}

/** Bringing one back from Deleted. */
export function restoreFailed(report: DeletableReport): ErrorCopy {
  if (isDraft(report)) {
    return {
      ORIGINAL_DELETED:
        'Could not restore: the report this corrects has been deleted. Restore that report first.',
      AMENDMENT_IN_PROGRESS:
        'Could not restore: another correction of this report is under way. Carry on with that one instead.',
      ALREADY_SUPERSEDED:
        'Could not restore: the report this corrects has been replaced by a later version since. Correct that one instead.',
      default: 'Could not restore the draft. Check your signal and try again.',
    }
  }
  return {
    NO_ACCESS:
      'Could not restore: only the business owner can restore a finalised report. Ask them to.',
    default: 'Could not restore the report. Check your signal and try again.',
  }
}
