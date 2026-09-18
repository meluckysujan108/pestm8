import { describe, expect, test } from 'vitest'
import { getTemplate } from './index'
import { reportProgress, sectionByKey } from './progress'
import type { ReportTemplate } from './types'

/**
 * Progress has one job: never lie about what is left.
 *
 * Two lies in particular. Telling a technician a section is done when a
 * required answer is missing sends them to a Finalise that refuses. Telling
 * them something is outstanding when the form is finished — counting a page of
 * terms as a question, or nagging about an answer they already changed — makes
 * the count noise they learn to ignore.
 */

const service = getTemplate('serviceReport')

const FILLED_SERVICE = {
  serviceDate: '2026-09-16',
  safeToStart: true,
  technicianSignature: { signedAt: 1789000000000 },
}

describe('what a section still wants', () => {
  test('counts the questions asked, not the pages to read', () => {
    // None of the three forms has a section that only reads, but a business's
    // own form can: a page of conditions, a notice, a disclaimer. It must
    // never be something the technician is told to "complete".
    const withNotice: ReportTemplate = {
      ...service,
      sections: [
        {
          id: 'notice',
          title: 'Recommendation Notice',
          fields: [
            {
              kind: 'note',
              key: 'notice',
              label: 'Notice',
              body: { type: 'doc', content: [] },
            },
          ],
        },
      ],
    }
    const [section] = reportProgress(withNotice, {}).sections
    expect(section.questions).toBe(0)
    expect(section.readingOnly).toBe(true)
    expect(section.done).toBe(true)
    expect(reportProgress(withNotice, {}).firstIncomplete).toBeNull()
  })

  test('names the required answers that are missing, in the order asked', () => {
    const progress = reportProgress(service, {})
    expect(progress.missingRequired).toEqual([
      'serviceDate',
      'safeToStart',
      'technicianSignature',
    ])
    expect(progress.complete).toBe(false)
  })

  test('is complete once the required answers are there', () => {
    const progress = reportProgress(service, FILLED_SERVICE)
    expect(progress.missingRequired).toEqual([])
    expect(progress.complete).toBe(true)
    expect(progress.firstIncomplete).toBeNull()
  })

  test('points Continue at the first section that still wants something', () => {
    const progress = reportProgress(service, { serviceDate: '2026-09-16' })
    // The date is answered, so the first thing outstanding is further down.
    expect(progress.firstIncomplete?.missing).toContain('safeToStart')
  })
})

describe('answers the app guessed', () => {
  test('block completion until they are confirmed', () => {
    const progress = reportProgress(
      service,
      { ...FILLED_SERVICE, weather: ['Wet'] },
      {
        prefill: { weather: { source: 'forecast' } },
      },
    )
    expect(progress.toConfirm).toEqual(['weather'])
    expect(progress.complete).toBe(false)
    const section = progress.sections.find((s) =>
      s.toConfirm.includes('weather'),
    )
    expect(section?.done).toBe(false)
  })

  test('stop blocking once confirmed', () => {
    const progress = reportProgress(
      service,
      { ...FILLED_SERVICE, weather: ['Wet'] },
      {
        prefill: {
          weather: { source: 'forecast', confirmedAt: 1789000000000 },
        },
      },
    )
    expect(progress.toConfirm).toEqual([])
    expect(progress.complete).toBe(true)
  })
})

describe('questions that come and go', () => {
  test('a hidden question is not missing — it is not being asked', () => {
    const cert = getTemplate('termiteManagementCert')
    const hiddenSomewhere = reportProgress(cert, {})
    const shownSomewhere = reportProgress(cert, { durableNoticeFitted: 'Yes' })
    // Answering "was a durable notice fitted?" reveals where it was put, so
    // the form asks more than it did a moment ago.
    expect(shownSomewhere.sections.length).toBeGreaterThanOrEqual(
      hiddenSomewhere.sections.length,
    )
    const totalBefore = hiddenSomewhere.sections.reduce(
      (n, s) => n + s.questions,
      0,
    )
    const totalAfter = shownSomewhere.sections.reduce(
      (n, s) => n + s.questions,
      0,
    )
    expect(totalAfter).toBeGreaterThan(totalBefore)
  })
})

describe('photos, which live outside the answers', () => {
  const withRequiredPhoto: ReportTemplate = {
    ...service,
    sections: [
      {
        id: 'evidence',
        title: 'Evidence',
        fields: [
          {
            kind: 'gallery',
            key: 'photos',
            label: 'Report Photos',
            required: true,
          },
        ],
      },
    ],
  }

  test('count when the caller can see them', () => {
    expect(
      reportProgress(withRequiredPhoto, {}, { photoCounts: { photos: 0 } })
        .missingRequired,
    ).toEqual(['photos'])
    expect(
      reportProgress(withRequiredPhoto, {}, { photoCounts: { photos: 2 } })
        .missingRequired,
    ).toEqual([])
  })

  test('never block when the caller cannot', () => {
    // The server validates a payload it was handed; refusing a report because
    // it could not count photos would lock a technician out of their own work.
    expect(reportProgress(withRequiredPhoto, {}).missingRequired).toEqual([])
  })
})

describe('addressing a section', () => {
  test('uses the template own stable id', () => {
    const progress = reportProgress(service, {})
    const first = progress.sections[0]
    expect(sectionByKey(progress, first.id)).toEqual(first)
    expect(sectionByKey(progress, 'not-a-section')).toBeNull()
    expect(sectionByKey(progress, undefined)).toBeNull()
  })
})
