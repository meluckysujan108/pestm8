/* The job sheet's Payment section, one job per state (`payments:forJob`). */

const NOW = Date.now()

function row(over: Record<string, unknown> = {}) {
  return {
    _id: 'pay_1',
    method: 'cash',
    amount: 22000,
    receivedAt: NOW - 90_000,
    recordedAt: NOW - 90_000,
    recordedBy: 'm_sam',
    recordedByName: 'Sam Nguyen',
    reference: null,
    deposit: false,
    handOver: null,
    removedAt: null,
    removedByName: null,
    canRemove: true,
    ...over,
  }
}

const base = {
  payments: [] as Array<unknown>,
  removed: [] as Array<unknown>,
  paid: 0,
  owing: 22000,
  overpaid: 0,
  settled: false,
  pricesHidden: false,
  lastTime: null as null | { method: string; receivedAt: number },
}

const handOver = {
  from: 'm_sam',
  fromName: 'Sam Nguyen',
  to: 'm_owner',
  toName: 'Terence Walsh',
  note: 'Keep $50, the rest to the office',
  doneAt: null as number | null,
  canTick: true,
}

const STATES: Record<string, typeof base> = {
  pay_ask: {
    ...base,
    lastTime: { method: 'card', receivedAt: NOW - 180 * 86_400_000 },
  },
  pay_recorded: {
    ...base,
    payments: [row()],
    paid: 22000,
    owing: 0,
    settled: true,
  },
  pay_nocharge: {
    ...base,
    payments: [row({ method: 'noCharge', amount: 0 })],
    owing: 0,
    settled: true,
  },
  pay_invoiced: base,
  pay_part: {
    ...base,
    payments: [row({ amount: 10000, canRemove: false })],
    paid: 10000,
    owing: 12000,
  },
  pay_handover: {
    ...base,
    payments: [row({ handOver })],
    paid: 22000,
    owing: 0,
    settled: true,
  },
  pay_handed: {
    ...base,
    payments: [
      row({ handOver: { ...handOver, note: null, doneAt: NOW - 86_400_000 } }),
    ],
    paid: 22000,
    owing: 0,
    settled: true,
  },
  pay_two: {
    ...base,
    payments: [
      row({
        _id: 'pay_a',
        method: 'bankTransfer',
        amount: 5000,
        deposit: true,
        reference: 'INV-2418',
        receivedAt: NOW - 8 * 86_400_000,
      }),
      row({ _id: 'pay_b', method: 'card', amount: 17000 }),
    ],
    removed: [
      row({
        _id: 'pay_c',
        amount: 17000,
        removedAt: NOW - 60_000,
        removedByName: 'Sam Nguyen',
      }),
    ],
    paid: 22000,
    owing: 0,
    settled: true,
  },
  pay_over: {
    ...base,
    payments: [row()],
    paid: 22000,
    owing: 0,
    overpaid: 3000,
    settled: true,
  },
  pay_hidden: { ...base, owing: 0, pricesHidden: true },
  pay_hidden_done: {
    ...base,
    payments: [row({ amount: 0 })],
    owing: 0,
    settled: true,
    pricesHidden: true,
  },
  pay_noprice: { ...base, owing: 0 },
}

export function paymentsForJob(args: { jobId: string }) {
  if (args.jobId === 'pay_loading') return undefined
  return STATES[args.jobId] ?? base
}

/* The Payments page (`payments:summary`, `outstanding`, `paidIn`), by business:
 * `biz_pay` a business with two people, `biz_pay_empty` one with nothing
 * waiting, `biz_pay_hidden` someone who cannot see prices. */

const DAY = 86_400_000

const people = [
  {
    membershipId: 'm_owner',
    name: 'Terence Walsh',
    toBill: 3,
    toBillValue: 66000,
    owing: 2,
    owingValue: 74000,
    paidThisMonth: 312000,
    paidThisMonthByMethod: [],
  },
  {
    membershipId: 'm_sam',
    name: 'Sam Nguyen',
    toBill: 1,
    toBillValue: 22000,
    owing: 1,
    owingValue: 20000,
    paidThisMonth: 174000,
    paidThisMonthByMethod: [],
  },
]

const summaries: Record<string, unknown> = {
  biz_pay: {
    toBill: 4,
    toBillValue: 88000,
    owing: 3,
    owingValue: 94000,
    owingSince: NOW - 34 * DAY,
    olderNotCounted: 117,
    olderNotCountedValue: 3771000,
    paidThisMonth: 486000,
    paidThisMonthByMethod: [],
    byPerson: people,
    toHandOver: [
      {
        from: 'm_sam',
        to: 'm_owner',
        fromName: 'Sam Nguyen',
        toName: 'Terence Walsh',
        value: 44000,
        paymentIds: ['pay_h1', 'pay_h2'],
        canTick: true,
      },
    ],
    pricesHidden: false,
    scope: 'business',
    countsFrom: NOW - 9 * DAY,
    canMoveCountsFrom: true,
  },
  biz_pay_empty: {
    toBill: 0,
    toBillValue: 0,
    owing: 0,
    owingValue: 0,
    owingSince: null,
    olderNotCounted: 0,
    olderNotCountedValue: 0,
    paidThisMonth: 0,
    paidThisMonthByMethod: [],
    byPerson: [],
    toHandOver: [],
    pricesHidden: false,
    scope: 'business',
    countsFrom: null,
    canMoveCountsFrom: true,
  },
  biz_pay_hidden: {
    toBill: null,
    toBillValue: null,
    owing: null,
    owingValue: null,
    owingSince: null,
    olderNotCounted: null,
    olderNotCountedValue: null,
    paidThisMonth: null,
    paidThisMonthByMethod: [],
    byPerson: [],
    toHandOver: [],
    pricesHidden: true,
    scope: 'assignee',
    countsFrom: NOW - 9 * DAY,
    canMoveCountsFrom: false,
  },
}

export function paymentsSummary(args: { businessId: string }) {
  return summaries[args.businessId] ?? summaries.biz_pay
}

function job(over: Record<string, unknown>) {
  return {
    _id: 'jp_out',
    jobNumber: 2391,
    jobType: 'General Pest Control',
    scheduledAt: NOW - 34 * DAY,
    completedAt: NOW - 34 * DAY,
    invoicedAt: null,
    clientName: 'Karrinyup Strata Group',
    suburb: 'Karrinyup',
    price: 48000,
    paid: 0,
    owing: 48000,
    lead: 'm_owner',
    leadName: 'Terence Walsh',
    ...over,
  }
}

const OWING = [
  job({ _id: 'jo1', invoicedAt: NOW - 34 * DAY }),
  job({
    _id: 'jo2',
    jobNumber: 2402,
    clientName: 'Dev Patel',
    suburb: 'Scarborough',
    scheduledAt: NOW - 21 * DAY,
    invoicedAt: NOW - 21 * DAY,
    price: 35000,
    paid: 15000,
    owing: 20000,
    lead: 'm_sam',
    leadName: 'Sam Nguyen',
  }),
  job({
    _id: 'jo3',
    jobNumber: 2377,
    clientName: 'Cottesloe Café',
    suburb: 'Cottesloe',
    scheduledAt: NOW - 16 * DAY,
    invoicedAt: NOW - 16 * DAY,
    price: 26000,
    owing: 26000,
  }),
]

const TO_BILL = [
  job({
    _id: 'jb1',
    jobNumber: 2410,
    clientName: 'Jan Morris',
    suburb: 'Nedlands',
    scheduledAt: NOW - 6 * DAY,
    completedAt: NOW - 6 * DAY,
    price: 22000,
    owing: 22000,
  }),
  job({
    _id: 'jb2',
    jobNumber: 2415,
    clientName: 'Harbour View Apartments',
    suburb: 'Fremantle',
    scheduledAt: NOW - 4 * DAY,
    completedAt: NOW - 4 * DAY,
    price: 32000,
    paid: 10000,
    owing: 22000,
  }),
  job({
    _id: 'jb3',
    jobNumber: 2421,
    clientName: 'Mia Chen',
    suburb: 'Floreat',
    scheduledAt: NOW - 2 * DAY,
    completedAt: NOW - 2 * DAY,
    price: 22000,
    owing: 22000,
    lead: 'm_sam',
    leadName: 'Sam Nguyen',
  }),
  job({
    _id: 'jb4',
    jobNumber: 2424,
    clientName: 'Leederville Bakery',
    suburb: 'Leederville',
    scheduledAt: NOW - DAY,
    completedAt: NOW - DAY,
    price: 22000,
    owing: 22000,
  }),
]

const zero = (rows: Array<ReturnType<typeof job>>) =>
  rows.map((one) => ({ ...one, price: 0, paid: 0, owing: 0 }))

export function paymentsOutstanding(args: {
  businessId: string
  list: 'owing' | 'toBill'
}) {
  const rows = args.list === 'owing' ? OWING : TO_BILL
  if (args.businessId === 'biz_pay_empty') {
    return { rows: [], more: false, pricesHidden: false }
  }
  if (args.businessId === 'biz_pay_hidden') {
    return {
      rows: zero(rows.filter((one) => one.lead === 'm_sam')),
      more: false,
      pricesHidden: true,
    }
  }
  return { rows, more: false, pricesHidden: false }
}

function paid(over: Record<string, unknown>) {
  return {
    _id: 'pp',
    jobId: 'jp1',
    jobNumber: 2418,
    clientName: 'Jan Morris',
    method: 'cash',
    amount: 22000,
    receivedAt: NOW - 3_600_000,
    dayKey: '',
    reference: null,
    deposit: false,
    whose: 'm_owner',
    whoseName: 'Terence Walsh',
    handOverTo: null,
    ...over,
  }
}

export function paymentsPaidIn(args: {
  businessId: string
  month?: string
  dayKeyOf: (ts: number) => string
}) {
  const thisMonth = args.dayKeyOf(NOW).slice(0, 7)
  const key = args.month ?? thisMonth
  const shared = {
    month: key,
    thisMonth: key === thisMonth,
    hasEarlier: true,
    more: false,
    pricesHidden: args.businessId === 'biz_pay_hidden',
  }
  if (args.businessId === 'biz_pay_empty' || key !== thisMonth) {
    return {
      ...shared,
      total: 0,
      byMethod: [],
      byPerson: [],
      rows: [],
    }
  }
  const rows = [
    paid({ _id: 'pp1', receivedAt: NOW - 2 * 3_600_000 }),
    paid({
      _id: 'pp2',
      jobId: 'jp3',
      jobNumber: 2419,
      clientName: 'Subi Café Group',
      method: 'card',
      amount: 26500,
      receivedAt: NOW - 3 * 3_600_000,
      whose: 'm_sam',
      whoseName: 'Sam Nguyen',
    }),
    paid({
      _id: 'pp3',
      jobId: 'jp2',
      jobNumber: 2416,
      clientName: 'Dev Patel',
      amount: 22000,
      receivedAt: NOW - DAY - 3_600_000,
      whose: 'm_owner',
      whoseName: 'Terence Walsh',
      handOverTo: 'Terence Walsh',
    }),
    paid({
      _id: 'pp4',
      jobId: 'jp2',
      jobNumber: 2402,
      clientName: 'Dev Patel',
      method: 'bankTransfer',
      amount: 15000,
      reference: 'INV-2402',
      receivedAt: NOW - 2 * DAY,
    }),
  ].map((one) => ({ ...one, dayKey: args.dayKeyOf(one.receivedAt) }))
  if (args.businessId === 'biz_pay_hidden') {
    const theirs = rows
      .filter((one) => one.whose === 'm_sam')
      .map((one) => ({ ...one, amount: 0 }))
    return { ...shared, total: null, byMethod: [], byPerson: [], rows: theirs }
  }
  return {
    ...shared,
    total: 85500,
    byMethod: [
      { method: 'cash', value: 44000, count: 2 },
      { method: 'card', value: 26500, count: 1 },
      { method: 'bankTransfer', value: 15000, count: 1 },
    ],
    byPerson: [
      { membershipId: 'm_owner', name: 'Terence Walsh', value: 59000 },
      { membershipId: 'm_sam', name: 'Sam Nguyen', value: 26500 },
    ],
    rows,
  }
}
