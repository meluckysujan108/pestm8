import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { JobEditChooser } from './JobEditChooser'
import { jobEditChoices } from '#/lib/jobEditChoices'
import type { ReactNode } from 'react'

// vaul's pieces as plain elements: there's no document here to open a real
// one in.
vi.mock('vaul', () => {
  const pass = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    Drawer: {
      Root: pass,
      Portal: pass,
      Overlay: () => null,
      Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children?: ReactNode }) => (
        <p data-description>{children}</p>
      ),
      Content: pass,
      Handle: () => null,
    },
  }
})

function render(open = true) {
  return renderToStaticMarkup(
    <JobEditChooser
      open={open}
      onClose={() => {}}
      description="Job #2320 · General Pest Control"
      choices={jobEditChoices({
        canEdit: true,
        status: 'pending',
        property: {
          addressLine: '14 Kewdale Road',
          client: { name: 'Mahal Mart', kind: 'business' },
        },
      })}
      onChoose={() => {}}
      returnFocusRef={{ current: null }}
    />,
  )
}

describe('the Edit sheet', () => {
  test('is titled "Edit", says which job, and ends with Done', () => {
    const html = render()
    expect(html).toContain('<h2>Edit</h2>')
    expect(html).toContain(
      '<p data-description="true">Job #2320 · General Pest Control</p>',
    )
    expect(html).toMatch(/<button[^>]*>Done<\/button>/)
  })

  test('offers each row as a row-card a finger can find: title, then what it changes', () => {
    const html = render()
    const rows = [
      ...html.matchAll(/<button[^>]*min-h-14[^>]*>(.*?)<\/button>/g),
    ]
    expect(rows).toHaveLength(3)
    const texts = rows.map((row) => row[1].replace(/<[^>]+>/g, ' '))
    expect(texts[0]).toMatch(/^\s*Job details\s+Date, times, property/)
    expect(texts[1]).toMatch(
      /^\s*Client details\s+Name, contact person, main phone and email — on all of Mahal Mart’s jobs\./,
    )
    expect(texts[2]).toMatch(
      /^\s*Property details\s+Correct the address or site contact — on every job at 14 Kewdale Road\./,
    )
    // A chevron on each, unheard.
    for (const row of rows) {
      expect(row[1]).toMatch(/<svg[^>]*lucide-chevron-right[^>]*>/)
      expect(row[1].match(/<svg[^>]*>/)?.[0]).toContain('aria-hidden="true"')
    }
  })

  test('draws nothing while it has never been opened', () => {
    expect(render(false)).not.toContain('Client details')
  })
})
