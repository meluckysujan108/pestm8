import { describe, expect, test } from 'vitest'
import {
  amountHint,
  amountProblem,
  amountText,
  countsFromLine,
  handOverLine,
  handOverPair,
  jobsWord,
  lastTimeLine,
  monthName,
  otherMethods,
  outstandingCaption,
  owingCaption,
  paidCaption,
  parseAmount,
  paymentAsk,
  paymentCardLine,
  paymentPhrase,
  paymentQuestion,
  paymentSaveKey,
  paymentTiles,
  receiptDetail,
  receiptTitle,
  recordLabel,
  stepMonth,
  toBillCaption,
} from './payments'
import type { PaymentMethod } from './payments'

/** The words the job sheet's Payment section and a job's card use. */

const TZ = 'Australia/Perth'
const TODAY = '2026-11-10'
/** 10:34am in Perth, today. */
const THIS_MORNING = Date.UTC(2026, 10, 10, 2, 34)
/** 10:35am in Perth, Monday of last week. */
const LAST_WEEK = Date.UTC(2026, 10, 2, 2, 35)
/** Stays with the word before it, so a wrapped line never starts on a dot. */
const DOT = ' · '

describe('whether the question is asked', () => {
  const job = (status: string, canEdit = true) => ({ status, canEdit })

  test.each(['pending', 'booked', 'recurring'])(
    'a %s visit is asked once its day has come',
    (status) => {
      expect(paymentAsk(job(status), '2026-11-11', TODAY)).toBe('none')
      expect(paymentAsk(job(status), TODAY, TODAY)).toBe('open')
      expect(paymentAsk(job(status), '2026-11-09', TODAY)).toBe('open')
    },
  )

  test('finished work is asked, whatever day it was booked for', () => {
    expect(paymentAsk(job('completed'), '2026-11-20', TODAY)).toBe('open')
  })

  test('once billed it waits behind a tap, as the answer comes later', () => {
    expect(paymentAsk(job('invoiced'), TODAY, TODAY)).toBe('onTap')
  })

  test.each(['paid', 'cancelled'])('a %s job has nothing to ask', (status) => {
    expect(paymentAsk(job(status), TODAY, TODAY)).toBe('none')
  })

  test('someone who can only read the job is never asked', () => {
    expect(paymentAsk(job('completed', false), TODAY, TODAY)).toBe('none')
    expect(paymentAsk(job('invoiced', false), TODAY, TODAY)).toBe('none')
  })
})

describe('the choices', () => {
  const tiles = (billed: boolean) =>
    paymentTiles(billed).map(({ tile }) => tile)

  test('offers Invoice until it has been billed, then the transfer it asked for', () => {
    expect(tiles(false)).toEqual(['cash', 'card', 'invoice', 'other'])
    expect(tiles(true)).toEqual(['cash', 'card', 'bankTransfer', 'other'])
  })

  test('Other holds what is not on a tile, and only that', () => {
    const values = (billed: boolean) =>
      otherMethods(billed).map(({ value }) => value)
    expect(values(false)).toEqual([
      'bankTransfer',
      'cheque',
      'other',
      'noCharge',
    ])
    expect(values(true)).toEqual(['cheque', 'other', 'noCharge'])
  })

  test('says what Other holds, without naming what has its own tile', () => {
    const other = (billed: boolean) =>
      paymentTiles(billed).find(({ tile }) => tile === 'other')?.line
    expect(other(false)).toBe('Transfer, cheque, no charge')
    expect(other(true)).toBe('Cheque, no charge')
  })

  test('a deposit has no Invoice, and nothing to give away', () => {
    expect(paymentTiles(false, true).map(({ tile }) => tile)).toEqual([
      'cash',
      'card',
      'bankTransfer',
      'other',
    ])
    expect(
      paymentTiles(false, true).find(({ tile }) => tile === 'other')?.line,
    ).toBe('Cheque or other')
    expect(otherMethods(false, true).map(({ value }) => value)).toEqual([
      'cheque',
      'other',
    ])
  })
})

describe('the question', () => {
  test('asks after a person by first name', () => {
    expect(paymentQuestion({ name: 'Jan Morris', kind: 'person' })).toBe(
      'How did Jan pay?',
    )
  })

  test('does not ask a business by name', () => {
    expect(paymentQuestion({ name: 'Cottesloe Café', kind: 'business' })).toBe(
      'How did they pay?',
    )
  })

  test.each(['J. Nguyen', 'J Nguyen'])(
    'does not ask after an initial (%s)',
    (name) => {
      expect(paymentQuestion({ name, kind: 'person' })).toBe(
        'How did they pay?',
      )
    },
  )

  test.each([null, undefined, { name: '  ', kind: 'person' as const }])(
    'still asks with no name to use (%j)',
    (client) => {
      expect(paymentQuestion(client)).toBe('How did they pay?')
    },
  )

  test('remembers how this address paid last', () => {
    expect(
      lastTimeLine({ method: 'card', receivedAt: LAST_WEEK }, TZ, TODAY),
    ).toBe('Last time: Card · Mon 2 Nov')
    expect(lastTimeLine(null, TZ, TODAY)).toBeNull()
    expect(lastTimeLine(undefined, TZ, TODAY)).toBeNull()
  })
})

describe('what is typed as an amount', () => {
  test.each([
    ['220', 22000],
    ['220.5', 22050],
    ['220.50', 22050],
    ['$220', 22000],
    ['$ 220', 22000],
    ['1,200.00', 120000],
    ['.5', 50],
    ['12.', 1200],
    ['  80 ', 8000],
    ['0', 0],
  ])('%j is %i cents', (raw, cents) => {
    expect(parseAmount(raw)).toBe(cents)
  })

  test('adds up to the cent, where binary fractions do not', () => {
    expect(parseAmount('19.99')).toBe(1999)
    expect(parseAmount('1.15')).toBe(115)
    expect(parseAmount('4.35')).toBe(435)
  })

  test.each(['', ' ', 'abc', '1.234', '12..5', '-5', '12a', '$', '.', '1 000'])(
    '%j is not an amount',
    (raw) => {
      expect(parseAmount(raw)).toBeNull()
    },
  )

  test('reads back as it was first drawn', () => {
    expect(amountText(22000)).toBe('220.00')
    expect(amountText(22050)).toBe('220.50')
    expect(parseAmount(amountText(22050))).toBe(22050)
  })
})

describe('whether an amount can be recorded', () => {
  test('all that is owing, or any part of it', () => {
    expect(amountProblem(22000, 22000)).toBeNull()
    expect(amountProblem(1, 22000)).toBeNull()
  })

  test('says what is wrong with one that cannot', () => {
    expect(amountProblem(null, 22000)).toBe(
      'Enter an amount, like 120 or 120.50.',
    )
    expect(amountProblem(0, 22000)).toBe('Enter more than $0.')
    expect(amountProblem(22001, 22000)).toBe('That’s more than the $220 owing.')
  })

  test('the hint says what a smaller amount leaves', () => {
    expect(amountHint(10000, 22000, false)).toBe('Leaves $120 owing.')
    expect(amountHint(10000, 22000, true)).toBe('Leaves $120 owing.')
  })

  test('and what the figure already there is', () => {
    expect(amountHint(22000, 22000, false)).toBe(
      'The job’s price. Change it for a part payment.',
    )
    expect(amountHint(12000, 12000, true)).toBe(
      'What’s still owing. Change it for a part payment.',
    )
    expect(amountHint(null, 22000, false)).toBe(
      'The job’s price. Change it for a part payment.',
    )
  })
})

describe('saves of a job’s money', () => {
  test('are told apart by job, so one job waiting does not hold up another', () => {
    expect(paymentSaveKey('j1')).toEqual(paymentSaveKey('j1'))
    expect(paymentSaveKey('j1')).not.toEqual(paymentSaveKey('j2'))
  })
})

describe('the button', () => {
  test.each<[PaymentMethod, string]>([
    ['cash', 'Record $220 cash'],
    ['card', 'Record $220 card'],
    ['bankTransfer', 'Record $220 transfer'],
    ['cheque', 'Record $220 cheque'],
    ['other', 'Record $220'],
    ['noCharge', 'Record no charge'],
  ])('%s says what it will save', (method, label) => {
    expect(recordLabel(method, 22000, false)).toBe(label)
  })

  test('says no figure until there is one to say', () => {
    expect(recordLabel('cash', null, false)).toBe('Record cash')
    expect(recordLabel('cash', 0, false)).toBe('Record cash')
    expect(recordLabel('other', null, false)).toBe('Record payment')
  })

  test('someone who cannot see the price still knows what it does', () => {
    expect(recordLabel('cash', 22000, true)).toBe('Record cash, paid in full')
    expect(recordLabel('bankTransfer', 0, true)).toBe(
      'Record transfer, paid in full',
    )
    expect(recordLabel('other', 0, true)).toBe('Record payment, paid in full')
    expect(recordLabel('noCharge', 0, true)).toBe('Record no charge')
  })
})

describe('a payment as it reads afterwards', () => {
  const receipt = {
    method: 'cash' as const,
    amount: 22000,
    deposit: false,
    receivedAt: THIS_MORNING,
    dayOnly: false,
    recordedByName: 'Sam Lee',
    reference: null,
  }

  test('titled by what it was', () => {
    expect(receiptTitle(receipt, false)).toBe('Paid $220')
    expect(receiptTitle({ ...receipt, deposit: true }, false)).toBe(
      'Deposit $220',
    )
    expect(receiptTitle({ ...receipt, method: 'noCharge' }, false)).toBe(
      'No charge',
    )
  })

  test('with no figure for someone who cannot see prices', () => {
    expect(receiptTitle({ ...receipt, amount: 0 }, true)).toBe('Paid')
    expect(receiptTitle({ ...receipt, amount: 0, deposit: true }, true)).toBe(
      'Deposit',
    )
  })

  test('how, when, who, and any reference', () => {
    expect(receiptDetail(receipt, TZ, TODAY)).toBe(
      `Cash${DOT}10:34am${DOT}Sam Lee`,
    )
    expect(
      receiptDetail(
        {
          ...receipt,
          method: 'bankTransfer',
          receivedAt: LAST_WEEK,
          reference: 'INV-2418',
        },
        TZ,
        TODAY,
      ),
    ).toBe(
      `Bank transfer${DOT}Mon 2 Nov, 10:35am${DOT}Sam Lee${DOT}Ref INV-2418`,
    )
  })

  test('a payment put on a day says the day, and no time it never had', () => {
    expect(
      receiptDetail(
        {
          ...receipt,
          method: 'bankTransfer',
          receivedAt: LAST_WEEK,
          dayOnly: true,
        },
        TZ,
        TODAY,
      ),
    ).toBe(`Bank transfer${DOT}Mon 2 Nov${DOT}Sam Lee`)
  })

  test('leaves out what it does not know, and the method of a No charge', () => {
    expect(
      receiptDetail(
        { ...receipt, method: 'noCharge', recordedByName: null },
        TZ,
        TODAY,
      ),
    ).toBe('10:34am')
  })

  test('as the question about taking it back names it', () => {
    expect(paymentPhrase({ method: 'cash', amount: 22000 }, false)).toBe(
      '$220 cash',
    )
    expect(paymentPhrase({ method: 'other', amount: 22000 }, false)).toBe(
      '$220',
    )
    expect(paymentPhrase({ method: 'noCharge', amount: 0 }, false)).toBe(
      'The no charge',
    )
    expect(paymentPhrase({ method: 'card', amount: 0 }, true)).toBe(
      'The card payment',
    )
    expect(paymentPhrase({ method: 'other', amount: 0 }, true)).toBe(
      'The other payment',
    )
  })
})

describe('a hand-over', () => {
  const mark = {
    from: 'sam',
    fromName: 'Sam Lee',
    toName: 'Terence Walsh',
    doneAt: null,
  }
  const line = (over: Partial<typeof mark> | object, recordedBy = 'sam') =>
    handOverLine({ ...mark, ...over }, recordedBy, TZ, TODAY)

  test('says who it is to', () => {
    expect(line({})).toBe('To hand over to Terence Walsh')
  })

  test('says who has it when that is not who took it', () => {
    expect(line({}, 'kevin')).toBe(
      'With Sam Lee, to hand over to Terence Walsh',
    )
  })

  test('says when it was done', () => {
    expect(line({ doneAt: LAST_WEEK })).toBe(
      `Handed over to Terence Walsh${DOT}Mon 2 Nov`,
    )
  })

  test('still reads when the person has left the team', () => {
    expect(line({ toName: null })).toBe(
      'To hand over to someone no longer on the team',
    )
  })
})

describe('the line on a job’s card', () => {
  const on = (
    status: string,
    methods: ReadonlyArray<PaymentMethod>,
    paid = 0,
    owing = 0,
    hidden = false,
  ) => paymentCardLine(status, { methods, paid, owing }, hidden)

  test('says nothing when the answer came from before there were payments', () => {
    expect(paymentCardLine('paid', undefined, false)).toBeNull()
  })

  test('says nothing of work still to come, deposit or not', () => {
    expect(on('booked', ['cash'], 5000, 17000)).toBeNull()
    expect(on('cancelled', ['cash'], 5000, 0)).toBeNull()
  })

  test.each<[ReadonlyArray<PaymentMethod>, string]>([
    [['cash'], 'Paid by cash'],
    [['bankTransfer', 'card'], 'Paid by bank transfer and card'],
    [['cash', 'card', 'cheque'], 'Paid by cash, card and cheque'],
    [['other'], 'Paid'],
    [['cash', 'other'], 'Paid by cash'],
    [['noCharge'], 'No charge'],
    [['cash', 'noCharge'], 'Paid by cash'],
  ])('paid with %j reads %j', (methods, text) => {
    expect(on('paid', methods, 22000)).toEqual({ text, quiet: false })
  })

  test('finished and not yet billed is the one worth skipping', () => {
    expect(on('completed', [], 0, 22000)).toEqual({
      text: 'No payment recorded',
      quiet: true,
    })
  })

  test('a deposit on finished work leaves the rest to bill', () => {
    expect(on('completed', ['cash'], 5000, 17000)).toEqual({
      text: '$50 deposit · $170 to bill',
      quiet: false,
    })
  })

  test('billed says what is owing, and what has come in', () => {
    expect(on('invoiced', [], 0, 35000)).toEqual({
      text: '$350 owing',
      quiet: false,
    })
    expect(on('invoiced', ['card'], 15000, 20000)).toEqual({
      text: '$150 paid · $200 owing',
      quiet: false,
    })
  })

  test('billed with nothing owing has nothing to say', () => {
    expect(on('invoiced', [], 0, 0)).toBeNull()
  })

  test('hidden prices keep how it was paid and lose every figure', () => {
    expect(on('paid', ['cash'], 0, 0, true)?.text).toBe('Paid by cash')
    expect(on('invoiced', ['cash'], 0, 0, true)?.text).toBe('Part paid')
    expect(on('invoiced', [], 0, 0, true)).toBeNull()
    expect(on('completed', [], 0, 0, true)).toEqual({
      text: 'No payment recorded',
      quiet: true,
    })
  })
})

describe('the Payments page', () => {
  const DAY = 24 * 60 * 60 * 1000

  test('counts jobs in digits', () => {
    expect(jobsWord(1)).toBe('1 job')
    expect(jobsWord(9)).toBe('9 jobs')
  })

  const at = { timezone: TZ, today: TODAY }

  test('says how long the oldest bill has waited', () => {
    expect(owingCaption(3, THIS_MORNING - 34 * DAY, at)).toBe(
      `3 jobs${DOT}oldest 34 days`,
    )
    expect(owingCaption(1, THIS_MORNING - DAY, at)).toBe(
      `1 job${DOT}billed 1 day ago`,
    )
    expect(owingCaption(1, THIS_MORNING, at)).toBe(`1 job${DOT}billed today`)
    expect(owingCaption(2, THIS_MORNING, at)).toBe(
      `2 jobs${DOT}all billed today`,
    )
    // Billed before bills were dated, or the day withheld.
    expect(owingCaption(2, null, at)).toBe('2 jobs')
  })

  test('counts calendar days in the business’s zone, not 24 hours', () => {
    // 5pm yesterday in Perth, read at 10:34am: yesterday, though only 17
    // hours have passed.
    const fivePmYesterday = Date.UTC(2026, 10, 9, 9, 0)
    expect(owingCaption(1, fivePmYesterday, at)).toBe(
      `1 job${DOT}billed 1 day ago`,
    )
    // 11pm three days back is three days ago, not two.
    const lateThreeDaysBack = Date.UTC(2026, 10, 7, 15, 0)
    expect(owingCaption(1, lateThreeDaysBack, at)).toBe(
      `1 job${DOT}billed 3 days ago`,
    )
  })

  test('says nothing under a total with nothing in it, or none it may see', () => {
    expect(owingCaption(0, null, at)).toBeNull()
    expect(owingCaption(null, null, at)).toBeNull()
    expect(toBillCaption(0)).toBeNull()
    expect(toBillCaption(null)).toBeNull()
    expect(toBillCaption(4)).toBe('4 jobs done, not billed')
  })

  describe('a job waiting on money', () => {
    const row = {
      jobNumber: 2391,
      scheduledAt: LAST_WEEK,
      completedAt: LAST_WEEK,
      invoicedAt: THIS_MORNING,
      price: 35000,
      paid: 0,
      leadName: 'Sam Nguyen',
    }
    const opts = {
      timezone: TZ,
      today: TODAY,
      showLead: false,
      pricesHidden: false,
    }

    test('owing: the day it was billed, or the visit before bills were dated', () => {
      expect(outstandingCaption(row, 'owing', opts)).toBe(
        `#2391${DOT}invoiced Tue 10 Nov`,
      )
      expect(
        outstandingCaption({ ...row, invoicedAt: null }, 'owing', opts),
      ).toBe(`#2391${DOT}visited Mon 2 Nov`)
    })

    test('what came in already, part of a bill or a deposit', () => {
      expect(outstandingCaption({ ...row, paid: 15000 }, 'owing', opts)).toBe(
        `#2391${DOT}$150 of $350 paid`,
      )
      expect(outstandingCaption({ ...row, paid: 10000 }, 'toBill', opts)).toBe(
        `#2391${DOT}$100 deposit`,
      )
    })

    test('to bill: the day it was done', () => {
      expect(
        outstandingCaption({ ...row, invoicedAt: null }, 'toBill', opts),
      ).toBe(`#2391${DOT}done Mon 2 Nov`)
    })

    test('names the lead by first name, only where the list mixes people', () => {
      expect(
        outstandingCaption(row, 'owing', { ...opts, showLead: true }),
      ).toBe(`#2391${DOT}Sam${DOT}invoiced Tue 10 Nov`)
    })

    test('no figures for someone who cannot see prices, and no number for a job without one', () => {
      expect(
        outstandingCaption({ ...row, jobNumber: null, paid: 15000 }, 'owing', {
          ...opts,
          pricesHidden: true,
        }),
      ).toBe('invoiced Tue 10 Nov')
    })
  })

  test('says where counting starts and what it leaves out', () => {
    expect(countsFromLine(null, 117, TZ, TODAY)).toBe('Counting every job.')
    expect(countsFromLine(LAST_WEEK, 117, TZ, TODAY)).toBe(
      'Counting work from Mon 2 Nov. 117 older jobs not counted.',
    )
    expect(countsFromLine(LAST_WEEK, 1, TZ, TODAY)).toBe(
      'Counting work from Mon 2 Nov. 1 older job not counted.',
    )
    expect(countsFromLine(LAST_WEEK, 0, TZ, TODAY)).toBe(
      'Counting work from Mon 2 Nov.',
    )
    expect(countsFromLine(LAST_WEEK, null, TZ, TODAY)).toBe(
      'Counting work from Mon 2 Nov.',
    )
  })

  describe('a payment on the Paid list', () => {
    const row = {
      jobNumber: 2418,
      method: 'cash' as const,
      receivedAt: THIS_MORNING,
      reference: null,
      deposit: false,
      dayOnly: false,
      whoseName: 'Sam Nguyen',
      handOverTo: null,
    }

    test('the job, how, when, and whose', () => {
      expect(paidCaption(row, { timezone: TZ, showWhose: true })).toBe(
        `#2418${DOT}Cash${DOT}10:34am${DOT}Sam`,
      )
      expect(paidCaption(row, { timezone: TZ, showWhose: false })).toBe(
        `#2418${DOT}Cash${DOT}10:34am`,
      )
    })

    test('no time on a payment put on a day: its day heading says it', () => {
      expect(
        paidCaption(
          { ...row, dayOnly: true },
          { timezone: TZ, showWhose: false },
        ),
      ).toBe(`#2418${DOT}Cash`)
    })

    test('a deposit, a reference, and money still to pass on', () => {
      expect(
        paidCaption(
          {
            ...row,
            method: 'bankTransfer',
            deposit: true,
            reference: '8841',
            whoseName: 'Terence Walsh',
            handOverTo: 'Terence Walsh',
          },
          { timezone: TZ, showWhose: true },
        ),
      ).toBe(
        `#2418${DOT}Bank transfer${DOT}10:34am${DOT}Deposit${DOT}Ref 8841${DOT}To hand over to Terence`,
      )
    })
  })

  test('names a month, with the year only when it is not this one', () => {
    expect(monthName('2026-11', '2026-11')).toBe('November')
    expect(monthName('2026-01', '2026-11')).toBe('January')
    expect(monthName('2025-12', '2026-01')).toBe('December 2025')
  })

  test('steps a month across the turn of a year', () => {
    expect(stepMonth('2026-01', -1)).toBe('2025-12')
    expect(stepMonth('2026-12', 1)).toBe('2027-01')
    expect(stepMonth('2026-11', -1)).toBe('2026-10')
    expect(stepMonth('2026-11', 0)).toBe('2026-11')
  })

  describe('who a hand-over is between', () => {
    const pair = {
      from: 'm_sam',
      to: 'm_owner',
      fromName: 'Sam Nguyen',
      toName: 'Terence Walsh',
    }

    test('says you for the reader', () => {
      expect(handOverPair(pair, 'm_owner')).toBe('Sam Nguyen to you')
      expect(handOverPair(pair, 'm_sam')).toBe('You to Terence Walsh')
      expect(handOverPair(pair, 'm_other')).toBe('Sam Nguyen to Terence Walsh')
    })

    test('someone who has left still reads as a sentence', () => {
      expect(handOverPair({ ...pair, fromName: null }, 'm_owner')).toBe(
        'Someone no longer on the team to you',
      )
      expect(handOverPair({ ...pair, toName: null }, 'm_sam')).toBe(
        'You to someone no longer on the team',
      )
    })
  })
})
