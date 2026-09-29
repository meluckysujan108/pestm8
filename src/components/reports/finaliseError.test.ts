import { afterEach, describe, expect, test, vi } from 'vitest'
import { ConvexError } from 'convex/values'
import { ERROR_COPY } from '#/components/forms/describeError'
import { finaliseError } from './ReportBuilder'

/**
 * What the report says when Finalise & lock did not lock it.
 *
 * Locking emails the report, so with no signal the lock is refused before it
 * is sent (`finalise` in ReportBuilder.tsx), rather than held until the
 * signal comes back and sent then. That refusal has to read as no signal —
 * not as "try again in a moment", which is what anything unnamed used to get.
 */

const plain = { isCorrection: false }

afterEach(() => vi.unstubAllGlobals())

describe('a finalise that did not lock', () => {
  test('with no signal, says so, and that the answers are still here', () => {
    expect(finaliseError(new Error('offline'), plain)).toBe(
      'Could not finalise: this device is offline. Your answers are still here — try again when you have signal.',
    )
  })

  test('refused for a reason of its own, still names it', () => {
    expect(
      finaliseError(
        new Error(
          '[CONVEX M(reports:finalise)] Uncaught ConvexError: REPORT_FINALISED',
        ),
        plain,
      ),
    ).toBe('This report has already been finalised.')
  })

  test('refused as every form can be, in the words every form uses', () => {
    expect(finaliseError(new ConvexError('UNAUTHENTICATED'), plain)).toBe(
      ERROR_COPY.UNAUTHENTICATED,
    )
  })

  test('anything else, with signal, keeps the general words', () => {
    vi.stubGlobal('navigator', { onLine: true })
    expect(finaliseError(new Error('Server Error'), plain)).toBe(
      'Could not finalise this report. Your answers are still saved — try again in a moment.',
    )
  })
})
