import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OutboxOnPhoneLine } from './OutboxOnPhoneLine'

/**
 * The sign-in screens' line (plan part 2c §11.4, S13, D26): whose bookings
 * not sent yet are on this phone, and that signing in as anyone else
 * discards them. What it says, with and without a first name, and nothing
 * once a sign-out has discarded them, is `onPhoneLine`'s
 * (lib/outbox/leaveAsk.test.ts); here, where it goes, and that each
 * screen's sign-in button names it for a screen reader.
 */

const LINE =
  'Kevin has 1 job on this phone not sent yet. It’s kept until Kevin signs in again and sends it. Signing in as anyone else discards it.'

const read = (file: string) =>
  readFileSync(resolve(import.meta.dirname, '../..', file), 'utf8')

describe('OutboxOnPhoneLine', () => {
  test('nothing while there is nothing to say: none, hydrating, or not read yet', () => {
    expect(
      renderToStaticMarkup(<OutboxOnPhoneLine line={null} id="on-phone" />),
    ).toBe('')
  })

  test('hangs below the line above it, taking no room: the centred form above never moves under a thumb', () => {
    const html = renderToStaticMarkup(
      <OutboxOnPhoneLine line={LINE} id="on-phone" />,
    )
    expect(html).toContain(LINE)
    expect(html).toMatch(
      /^<div class="relative h-0"><p id="on-phone" class="absolute /,
    )
  })

  test('`over`, sits at the top of the box it is put in, taking no room there either', () => {
    const html = renderToStaticMarkup(
      <OutboxOnPhoneLine line={LINE} id="on-phone" over />,
    )
    expect(html).toBe(
      `<p id="on-phone" class="absolute inset-x-0 top-0 text-caption text-ink-2">${LINE}</p>`,
    )
  })

  test('the sign-in page says it under the title, over the line saying what PestM8 is, which gives way to it, so it is on screen on the smallest phone; its button names it while it shows (F18)', () => {
    // Hung below the form, as the screen's last line, it was off screen on
    // an iPhone SE in Safari from "Signing in as anyone else discards
    // them." on: the form, Forgot password? and Add to Home Screen leave
    // about 40px under them at 548px.
    const text = read('routes/login.tsx')
    const header = text.slice(0, text.indexOf('<form'))
    expect(header).toMatch(
      /<div className="relative mt-2">\s*<p\s+className=\{\s*onPhone === null\s*\? 'text-body text-muted'\s*: 'invisible text-body text-muted'\s*\}\s*>\s*Scheduling and compliance reporting for Australian pest control\.\s*<\/p>\s*<OutboxOnPhoneLine line=\{onPhone\} id=\{onPhoneId\} over \/>\s*<\/div>/,
    )
    expect(text.match(/<OutboxOnPhoneLine /g)).toHaveLength(1)
    expect(text).toMatch(
      /type="submit"[\s\S]{0,80}aria-describedby=\{onPhone === null \? undefined : onPhoneId\}/,
    )
  })

  test.each(['routes/join.$token.tsx', 'routes/start.$token.tsx'])(
    '%s says it while the form shows, signed out only, and the form’s button names it (F18)',
    (file) => {
      const text = read(file)
      expect(text).toContain(
        'const onPhone = signedInEmail === null ? onPhoneRead : null',
      )
      expect(text).toContain(
        '<OutboxOnPhoneLine line={onPhone} id={onPhoneId} over />',
      )
      expect(text.match(/<OutboxOnPhoneLine /g)).toHaveLength(1)
      expect(text).toMatch(
        /<InviteAuthForm[\s\S]{0,400}?describedBy=\{onPhone === null \? undefined : onPhoneId\}\s*\/>/,
      )
      // Above the form, so it is read before its button is reached.
      expect(text.indexOf('<OutboxOnPhoneLine ')).toBeLessThan(
        text.indexOf('<InviteAuthForm'),
      )
    },
  )

  test('the invitation form’s button carries what it is handed', () => {
    expect(read('components/auth/InviteAuthForm.tsx')).toMatch(
      /type="submit"[\s\S]{0,80}aria-describedby=\{describedBy\}/,
    )
  })

  test('on the join page it is under the title, over the line saying what the invitation is, which gives way to it: hung under the form, it was below the fold on an iPhone SE in sign-up (F16, round 6)', () => {
    // Sign-up's name, email, password and the "Already have an account?"
    // toggle end about 550px down at 375px wide, past the 548px of an
    // iPhone SE in Safari, so a line hung under them started off screen
    // while the button was on it.
    const text = read('routes/join.$token.tsx')
    expect(text).toMatch(
      /<Shell title=\{`Join \$\{businessName\}`\}>\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="relative mt-2">\s*<p\s+className=\{\s*onPhone === null\s*\? 'text-body text-muted'\s*: 'invisible text-body text-muted'\s*\}\s*>\s*You’ve been invited as a \{roleLabel\}\.[^<]*<span className="text-ink">\{emailHint\}<\/span>\.\s*<\/p>\s*<OutboxOnPhoneLine line=\{onPhone\} id=\{onPhoneId\} over \/>\s*<\/div>/,
    )
    // The note under the form no longer gives way to anything.
    expect(text).toMatch(
      /<p className="mt-8 text-caption leading-relaxed text-muted">\s*Once you join/,
    )
  })

  test('on the start page it is under the title, over the line saying what the link is, which gives way to it, used or not: hung under the form, it was below the fold even on a 390px iPhone (F16, round 6)', () => {
    const text = read('routes/start.$token.tsx')
    expect(text).toMatch(
      /<Shell title="Set up your business on PestM8">\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="relative mt-2">\s*<p\s+className=\{\s*onPhone === null\s*\? 'text-body text-muted'\s*: 'invisible text-body text-muted'\s*\}\s*>\s*\{taken \?[\s\S]*?This link works once, and only for\{' '\}\s*<span className="text-ink">\{emailHint\}<\/span>\.\s*<\/>\s*\)\}\s*<\/p>\s*<OutboxOnPhoneLine line=\{onPhone\} id=\{onPhoneId\} over \/>\s*<\/div>/,
    )
    // What is set up next no longer gives way to anything.
    expect(text).toContain('<section className="mt-10">')
  })
})
