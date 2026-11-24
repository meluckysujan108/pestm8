import { dayKeyOf } from '../../convex/lib/dates'
import {
  formatDuration,
  formatJobDate,
  formatMoney,
  formatTime,
} from './format'
import { jobStatusStyle } from './statusColours'
import { namesOf } from './jobPeople'
import { PAYMENT_METHOD } from './payments'
import type {
  ActivityEntry,
  ActivityPerson,
  ShownChange,
} from '../../convex/jobActivity'

/**
 * A line of a job's Activity in words (`JobActivitySection`): who did it,
 * and one sentence for each thing they did.
 *
 * "You" for the person reading, and "in Kevin's account" when it was done
 * there. A sentence for the action itself only where its changes don't say
 * it already: a job marked Completed says so with its status, and a photo
 * added changes no field, so it says so in a sentence.
 */

export type ActivityWords = {
  who: string
  lines: Array<string>
}

/** "Terence", "You", "Terence, in Kevin’s account". */
export function whoDidIt(entry: Pick<ActivityEntry, 'by' | 'inAccountOf'>) {
  const who = entry.by.you ? 'You' : entry.by.name
  if (entry.inAccountOf === null) return who
  const whose = entry.inAccountOf.you ? 'your' : `${entry.inAccountOf.name}’s`
  return `${who}, in ${whose} account`
}

export function activityWords(
  entry: ActivityEntry,
  timezone: string,
  today: string,
): ActivityWords {
  const changes = entry.changes.filter((change) => !saidBy(entry, change))
  const title = actionLine(entry)
  return {
    who: whoDidIt(entry),
    lines: [
      ...(title === null ? [] : [title]),
      ...changes.flatMap((change) => changeLines(change, timezone, today)),
    ],
  }
}

/** A change its action's own sentence already says. */
function saidBy(entry: ActivityEntry, change: ShownChange): boolean {
  if (entry.action === 'recurrence.stop') return change.field === 'status'
  if (entry.action === 'membership.handOn') return change.field === 'lead'
  if (entry.action === 'membership.takeOff') return change.field === 'alsoGoing'
  return false
}

/** The action as a sentence, or null where its changes say it. */
function actionLine(entry: ActivityEntry): string | null {
  const statusChanged = entry.changes.some((c) => c.field === 'status')
  switch (entry.action) {
    case 'job.create':
      return 'Booked this job'
    case 'job.update':
      return null
    case 'job.complete':
      return statusChanged ? null : 'Marked it completed'
    case 'job.cancel':
      return statusChanged ? null : 'Cancelled it'
    case 'job.invoice':
      return statusChanged ? null : 'Marked it invoiced'
    case 'job.photo.add':
      return 'Added a photo'
    case 'job.photo.remove':
      return 'Removed a photo'
    case 'payment.record':
      return `Recorded ${paymentWords(entry.payment)}`
    case 'payment.remove':
      return `Took back ${paymentWords(entry.payment)}`
    case 'payment.handOver':
      return 'Changed who a payment is handed over to'
    case 'recurrence.convert':
      return entry.interval
        ? `Made it repeat ${entry.interval.toLowerCase()}`
        : 'Made it a Recurring Job'
    case 'recurrence.leave':
      return 'Stopped its Recurring Job, keeping this job'
    case 'recurrence.stop':
      return 'Cancelled when its Recurring Job was stopped'
    case 'membership.handOn': {
      const lead = entry.changes.find((c) => c.field === 'lead')
      return lead?.field === 'lead'
        ? `Handed it to ${person(lead.to)} from ${person(lead.from)}, who is no longer on the team`
        : 'Handed it on from someone no longer on the team'
    }
    case 'membership.takeOff': {
      const going = entry.changes.find((c) => c.field === 'alsoGoing')
      return going?.field === 'alsoGoing' && going.removed.length > 0
        ? `Took ${people(going.removed)} off it, who is no longer on the team`
        : 'Took someone no longer on the team off it'
    }
    case 'bin.delete':
      return deletedLine(entry.binRoot)
    case 'bin.restore':
      return 'Restored it from the Recycle bin'
  }
}

function deletedLine(root: ActivityEntry['binRoot']): string {
  switch (root) {
    case 'recurrence':
      return 'Deleted it with its Recurring Job'
    case 'property':
      return 'Deleted it with its site'
    case 'client':
      return 'Deleted it with its client'
    default:
      return 'Deleted this job'
  }
}

/** "a payment of $195 by card", "a deposit of $50 by cash", "no charge";
 * with the price hidden, "a payment by card". */
export function paymentWords(payment: ActivityEntry['payment']): string {
  if (payment === null) return 'a payment'
  if (payment.method === 'noCharge') return 'no charge'
  const noun = payment.deposit ? 'a deposit' : 'a payment'
  const amount =
    payment.amount === null ? '' : ` of ${formatMoney(payment.amount)}`
  const word = PAYMENT_METHOD[payment.method].word
  return `${noun}${amount}${word ? ` by ${word}` : ''}`
}

/** A person in the middle of a sentence: "you", or their name. */
function person(who: ActivityPerson): string {
  return who.you ? 'you' : who.name
}

function people(list: ReadonlyArray<ActivityPerson>): string {
  return namesOf(list.map((who) => ({ name: person(who) })))
}

function statusWord(status: string): string {
  return jobStatusStyle(status).label
}

/** "Tue 25 Nov, 9:00am". */
function moment(ts: number, timezone: string, today: string): string {
  return `${formatJobDate(dayKeyOf(ts, timezone), today)}, ${formatTime(ts, timezone)}`
}

function changeLines(
  change: ShownChange,
  timezone: string,
  today: string,
): Array<string> {
  switch (change.field) {
    case 'status':
      return [
        `Changed the status from ${statusWord(change.from)} to ${statusWord(change.to)}`,
      ]
    case 'scheduledAt': {
      const sameDay =
        dayKeyOf(change.from, timezone) === dayKeyOf(change.to, timezone)
      return sameDay
        ? [
            `Moved it from ${formatTime(change.from, timezone)} to ${formatTime(change.to, timezone)}, ${formatJobDate(dayKeyOf(change.to, timezone), today)}`,
          ]
        : [
            `Moved it from ${moment(change.from, timezone, today)} to ${moment(change.to, timezone, today)}`,
          ]
    }
    case 'durationMinutes':
      return [
        `Changed the length from ${formatDuration(change.from)} to ${formatDuration(change.to)}`,
      ]
    case 'lead':
      return [
        `Made ${person(change.to)} the lead, instead of ${person(change.from)}`,
      ]
    case 'alsoGoing':
      return [
        ...(change.added.length > 0
          ? [`Added ${people(change.added)} as also going`]
          : []),
        ...(change.removed.length > 0
          ? [`Took ${people(change.removed)} off it`]
          : []),
      ]
    case 'property': {
      const to = change.to ?? 'another address'
      return [
        change.from === null
          ? `Changed the address to ${to}`
          : `Changed the address from ${change.from} to ${to}`,
      ]
    }
    case 'jobType':
      return [`Changed the service from ${change.from} to ${change.to}`]
    case 'price':
      return [
        change.from === null || change.to === null
          ? 'Changed the price'
          : `Changed the price from ${formatMoney(change.from)} to ${formatMoney(change.to)}`,
      ]
    case 'workOrder':
      if (change.from === undefined) {
        return [`Added work order ${change.to ?? ''}`.trim()]
      }
      if (change.to === undefined) return [`Took off work order ${change.from}`]
      return [`Changed the work order from ${change.from} to ${change.to}`]
  }
}

/** The line a history starts with when nobody's booking is in it: a visit
 * its Recurring Job put on the schedule, or one booked before the business's
 * history began, by someone it never wrote down. */
export function originLine(
  origin: { at: number; bySeries: boolean },
  timezone: string,
  today: string,
): { line: string; when: string } {
  return {
    line: origin.bySeries
      ? 'Put on the schedule by its Recurring Job'
      : 'Booked',
    when: formatJobDate(dayKeyOf(origin.at, timezone), today),
  }
}

/** "Changes before Mon 24 Nov weren’t recorded." — for a job booked before
 * its business's history began. */
export function earlierLine(
  recordedSince: number | null,
  timezone: string,
  today: string,
): string {
  return recordedSince === null
    ? 'Earlier changes weren’t recorded.'
    : `Changes before ${formatJobDate(dayKeyOf(recordedSince, timezone), today)} weren’t recorded.`
}
