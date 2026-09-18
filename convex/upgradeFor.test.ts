import { describe, expect, test } from 'vitest'
import { upgradeFor } from './reports'
import { getTemplate } from '../src/lib/reportTemplates'
import type { Id } from './_generated/dataModel'

/**
 * Which drafts are offered a newer form. Pure, so it is pinned here rather than
 * through the builder: the e2e suite cannot make a draft on an old revision.
 */
describe('upgradeFor', () => {
  const original = 'k17original' as Id<'reports'>

  test('an old Service Report draft is offered the switch', () => {
    expect(upgradeFor({ template: 'serviceReport', templateVersion: 1 })).toBe(
      'switch',
    )
  })

  test('an old Timber or Certificate draft is offered a restart', () => {
    expect(
      upgradeFor({ template: 'timberPestInspection', templateVersion: 1 }),
    ).toBe('restart')
    expect(
      upgradeFor({
        template: 'termiteManagementCert',
        templateVersion: undefined,
      }),
    ).toBe('restart')
  })

  test('a draft on the current form is offered nothing', () => {
    const current = getTemplate('timberPestInspection').version
    expect(
      upgradeFor({
        template: 'timberPestInspection',
        templateVersion: current,
      }),
    ).toBeNull()
  })

  // "Start again" makes a brand-new report. On a correction that would issue it
  // as an unrelated document with its own number and leave the original current.
  test('a correction stays on the form its original was signed on', () => {
    for (const template of [
      'serviceReport',
      'timberPestInspection',
      'termiteManagementCert',
    ] as const) {
      expect(
        upgradeFor({
          template,
          templateVersion: 1,
          supersedesReportId: original,
        }),
      ).toBeNull()
    }
  })

  test('custom forms are never offered one', () => {
    expect(upgradeFor({ template: 'custom', templateVersion: 1 })).toBeNull()
  })
})
