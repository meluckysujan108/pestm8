/**
 * A job's Activity (`jobActivity.list`), for the section on its sheet.
 *
 * - `ja1`: the owner reading a busy job — a booking, a move, a price, a
 *   payment, and an edit made in Kevin's account — more than the four the
 *   card shows at first.
 * - `ja2`: the same job as Kevin reads it: no figures.
 * - `ja3`: a job changed more often than the fifty lines it reads.
 * - anything else: a job booked before the business's history began, with
 *   nothing done to it since.
 */

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const terence = { name: 'Terence Walsh', you: false }
const kevin = { name: 'Kevin Tran', you: false }
const jo = { name: 'Jo Bell', you: false }

function busyJob(reader: 'owner' | 'kevin') {
  const now = Date.now()
  const me = (who: { name: string; you: boolean }) =>
    (reader === 'owner' && who === terence) ||
    (reader === 'kevin' && who === kevin)
      ? { ...who, you: true }
      : who
  const priced = reader === 'owner'
  // Tomorrow at 9am, then 11am, in Perth-ish terms: the harness only needs
  // the two to be the same day.
  const tomorrowNine = Math.floor((now + DAY) / HOUR) * HOUR
  return {
    entries: [
      {
        _id: 'act6',
        at: now - 25 * 60 * 1000,
        action: 'payment.record',
        by: me(kevin),
        inAccountOf: null,
        changes: [],
        payment: {
          method: 'card',
          amount: priced ? 5000 : null,
          deposit: true,
        },
        interval: null,
        binRoot: null,
      },
      {
        _id: 'act5',
        at: now - 2 * HOUR,
        action: 'job.update',
        by: me(terence),
        inAccountOf: me(kevin),
        changes: [{ field: 'durationMinutes', from: 60, to: 90 }],
        payment: null,
        interval: null,
        binRoot: null,
      },
      {
        _id: 'act4',
        at: now - 3 * HOUR,
        action: 'job.update',
        by: me(terence),
        inAccountOf: null,
        changes: [
          {
            field: 'alsoGoing',
            added: [me(jo)],
            removed: [],
          },
          {
            field: 'price',
            from: priced ? 19500 : null,
            to: priced ? 22000 : null,
          },
        ],
        payment: null,
        interval: null,
        binRoot: null,
      },
      {
        _id: 'act3',
        at: now - DAY,
        action: 'job.update',
        by: me(terence),
        inAccountOf: null,
        changes: [
          {
            field: 'scheduledAt',
            from: tomorrowNine,
            to: tomorrowNine + 2 * HOUR,
          },
          { field: 'workOrder', to: 'PO-40213' },
        ],
        payment: null,
        interval: null,
        binRoot: null,
      },
      {
        _id: 'act2',
        at: now - 2 * DAY,
        action: 'job.update',
        by: me(terence),
        inAccountOf: null,
        changes: [
          {
            field: 'lead',
            from: me(terence),
            to: me(kevin),
          },
        ],
        payment: null,
        interval: null,
        binRoot: null,
      },
      {
        _id: 'act1',
        at: now - 3 * DAY,
        action: 'job.create',
        by: me(terence),
        inAccountOf: null,
        changes: [],
        payment: null,
        interval: null,
        binRoot: null,
      },
    ],
    more: false,
    origin: null,
    recordedSince: null,
    bookedBefore: false,
  }
}

/** Fifty edits to its length, an hour apart: one more than it reads. */
function longHistory() {
  const now = Date.now()
  return {
    entries: Array.from({ length: 50 }, (_, index) => ({
      _id: `long${index}`,
      at: now - (index + 1) * HOUR,
      action: 'job.update',
      by: { ...terence, you: true },
      inAccountOf: null,
      changes: [
        {
          field: 'durationMinutes',
          from: 60 + 15 * (index % 2),
          to: 75 - 15 * (index % 2),
        },
      ],
      payment: null,
      interval: null,
      binRoot: null,
    })),
    more: true,
    origin: null,
    recordedSince: null,
    bookedBefore: false,
  }
}

export function jobActivityFixture(jobId: string) {
  if (jobId === 'ja1') return busyJob('owner')
  if (jobId === 'ja2') return busyJob('kevin')
  if (jobId === 'ja3') return longHistory()
  const now = Date.now()
  return {
    entries: [],
    more: false,
    origin: { at: now - 40 * DAY, bySeries: false },
    recordedSince: now - 2 * DAY,
    bookedBefore: true,
  }
}
