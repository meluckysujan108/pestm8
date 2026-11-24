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

/**
 * The owner's Settings → Activity (`jobActivity.feed`), by business:
 *
 * - `biz_demo`: a busy business — today a move, a price and a payment, an
 *   edit made in Kevin's account and a job deleted with its client; earlier
 *   days a booking, a photo and a hand-on, and a line whose job has since
 *   been wiped. More behind it, so "Show more changes" shows. With
 *   `staffId: 'm_kev'`, only Kevin's own changes, read to the end.
 * - `biz_act_end`: a short history read to its end, with its foot.
 * - `biz_act_empty`: nothing changed yet.
 * - `biz_act_fail`: the read failed.
 * - anything else: no answer, so the page shows its placeholder.
 */
export function jobActivityFeedFixture(args: {
  businessId: string
  staffId?: string
}) {
  const now = Date.now()
  const at = (hoursAgo: number) => now - hoursAgo * HOUR
  const you = { name: 'Terence Walsh', you: true }
  const kev = { name: 'Kevin Doyle', you: false }
  const sam = { name: 'Sam Nguyen', you: false }
  const open = (
    jobType: string,
    client: string,
    suburb: string,
    daysAhead: number,
  ) => ({
    state: 'open' as const,
    jobType,
    client,
    suburb,
    scheduledAt: now + daysAhead * DAY,
  })
  const line = (
    id: string,
    hoursAgo: number,
    by: { name: string; you: boolean },
    job: unknown,
    over: Record<string, unknown> = {},
  ) => ({
    _id: id,
    at: at(hoursAgo),
    action: 'job.update',
    by,
    inAccountOf: null,
    changes: [],
    payment: null,
    interval: null,
    binRoot: null,
    jobId: `jf_${id}`,
    job,
    ...over,
  })

  const nguyen = open('General Pest Control', 'J. Nguyen', 'Bayswater', 1)
  const harbour = open(
    'Termite Inspection, Rodent Baiting',
    'Harbourside Strata',
    'Fremantle',
    3,
  )
  const smith = {
    state: 'binned' as const,
    jobType: 'Spider Treatment',
    client: 'Jane Smith',
    suburb: 'Subiaco',
    scheduledAt: now + 5 * DAY,
  }

  const kevins = [
    line('f2', 0.6, kev, nguyen, {
      action: 'payment.record',
      payment: { method: 'card', amount: 5000, deposit: true },
    }),
    line('f7', 26, kev, harbour, { action: 'job.photo.add' }),
  ]

  if (args.businessId === 'biz_act_empty') {
    return { page: [], isDone: true, continueCursor: '' }
  }
  if (args.businessId === 'biz_act_fail') {
    throw new Error('Could not reach PestM8')
  }
  if (args.businessId === 'biz_act_end') {
    return {
      page: [
        line('e2', 3, you, nguyen, {
          changes: [{ field: 'durationMinutes', from: 60, to: 90 }],
        }),
        line('e1', 50, you, nguyen, { action: 'job.create' }),
      ],
      isDone: true,
      continueCursor: '',
    }
  }
  if (args.businessId !== 'biz_demo') return undefined
  if (args.staffId === 'm_kev') {
    return { page: kevins, isDone: true, continueCursor: '' }
  }
  const nineTomorrow = Math.floor((now + DAY) / HOUR) * HOUR
  return {
    page: [
      line('f1', 0.2, you, nguyen, {
        changes: [
          {
            field: 'scheduledAt',
            from: nineTomorrow,
            to: nineTomorrow + 2 * HOUR,
          },
          { field: 'price', from: 19500, to: 22000 },
        ],
      }),
      kevins[0],
      line('f3', 1.5, you, harbour, {
        inAccountOf: kev,
        changes: [
          { field: 'lead', from: sam, to: kev },
          { field: 'alsoGoing', added: [sam], removed: [] },
        ],
      }),
      line('f4', 2.5, you, smith, {
        action: 'bin.delete',
        binRoot: 'client',
      }),
      line('f5', 24.5, sam, harbour, {
        changes: [
          {
            field: 'status',
            from: 'booked',
            to: 'completed',
          },
        ],
        action: 'job.complete',
      }),
      line('f6', 25, you, smith, { action: 'job.create' }),
      kevins[1],
      line(
        'f8',
        50,
        you,
        open('Ant Treatment', 'Oak & Ivy Café', 'Leederville', -1),
        {
          action: 'membership.handOn',
          changes: [
            {
              field: 'lead',
              from: { name: 'Alex Moore', you: false },
              to: sam,
            },
          ],
        },
      ),
      line('f9', 51, sam, { state: 'gone' }, { action: 'job.create' }),
    ],
    isDone: false,
    continueCursor: 'more',
  }
}
