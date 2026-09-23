import {
  boldParagraph,
  emptyDoc,
  heading,
  paragraph,
  taskList,
} from './richText'
import type { PmNode } from './richText'

/**
 * Starting documents for a new note, read by the server in `notes.create`.
 *
 * The library's "+" no longer offers them (Phase 5.3: it makes a blank
 * personal note); a job's "+ Site note" still uses `siteAccess`. All four
 * keys stay accepted, for frontends built before the menu went.
 */
export const NOTE_TEMPLATE_KEYS = [
  'blank',
  'siteAccess',
  'jobVisit',
  'teamMemo',
] as const
export type NoteTemplateKey = (typeof NOTE_TEMPLATE_KEYS)[number]

export const NOTE_TEMPLATES: Record<
  NoteTemplateKey,
  { label: string; blurb: string; doc: (title: string) => PmNode }
> = {
  blank: {
    label: 'Blank note',
    blurb: 'Start from nothing.',
    doc: (title) => ({
      type: 'doc',
      content: [heading(title), paragraph('')],
    }),
  },
  siteAccess: {
    label: 'Site access',
    blurb: 'Gate code, key, animals, hazards.',
    doc: (title) => ({
      type: 'doc',
      content: [
        heading(title || 'Site access'),
        boldParagraph('Access'),
        paragraph('Gate code: '),
        paragraph('Key: '),
        boldParagraph('Animals'),
        paragraph(''),
        boldParagraph('Hazards'),
        paragraph(''),
        boldParagraph('Before you arrive'),
        taskList(['Call ahead', 'Close the side gate behind you']),
        // Templates end on a paragraph so the editor's trailing-node rule
        // never has to author a fix-up step on the first keystroke.
        paragraph(''),
      ],
    }),
  },
  jobVisit: {
    label: 'Job visit',
    blurb: 'Findings, treatment, follow-ups.',
    doc: (title) => ({
      type: 'doc',
      content: [
        heading(title),
        boldParagraph('Findings'),
        paragraph(''),
        boldParagraph('Treatment applied'),
        paragraph(''),
        boldParagraph('Follow-ups'),
        taskList(['']),
        paragraph(''),
      ],
    }),
  },
  teamMemo: {
    label: 'Team memo',
    blurb: 'Procedures, mix ratios, supplier numbers.',
    doc: (title) => (title ? { type: 'doc', content: [heading(title), paragraph('')] } : emptyDoc()),
  },
}
