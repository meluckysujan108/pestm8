/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { testApp } from '../test/harness'
import { AuthBrowser } from '../test/authBrowser'
import { RESETS_PER_DAY } from './accountEmails'
import { passwordChangedEmail, passwordResetEmail } from './lib/accountEmail'
import type { TestApp } from '../test/harness'

/**
 * "Forgot password?" end to end, through Better Auth's real endpoints on this
 * app's real auth config: the reset email from noreply@, its one-use link,
 * the new password, every session ended, and the "your password was changed"
 * email after. Resend is the one thing faked — `fetch` to it is recorded.
 */

type Sent = {
  from: string
  to: Array<string>
  subject: string
  text: string
  html: string
}

let sent: Array<Sent>

beforeEach(() => {
  process.env.AUTH_BREACH_CHECK = 'off'
  vi.stubEnv('RESEND_API_KEY', 're_test')
  vi.stubEnv('RESEND_ACCOUNT_FROM_EMAIL', 'noreply@pestm8.com.au')
  sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.resend.com/emails')
      sent.push(JSON.parse(String(init.body)) as Sent)
      return new Response(JSON.stringify({ id: `msg_${sent.length}` }), {
        status: 200,
      })
    }),
  )
  vi.useFakeTimers()
})
afterEach(() => {
  delete process.env.AUTH_BREACH_CHECK
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a brand new long password'

function browserOn(t: TestApp) {
  return new AuthBrowser((path, init) => t.fetch(`/api/auth${path}`, init))
}

async function signUp(t: TestApp, email: string) {
  const browser = browserOn(t)
  const res = await browser.post('/sign-up/email', {
    name: 'Kevin Walsh',
    email,
    password: PASSWORD,
  })
  expect(res.status).toBe(200)
  return browser
}

async function askForReset(t: TestApp, email: string) {
  const res = await browserOn(t).post('/request-password-reset', { email })
  expect(res.status).toBe(200)
  await t.finishAllScheduledFunctions(vi.runAllTimers)
}

function tokenIn(email: Sent): string {
  const match = /\/reset-password\?token=([^\s"<&]+)/.exec(email.text)
  expect(match).not.toBeNull()
  return decodeURIComponent(match![1])
}

describe('forgot password', () => {
  test('emails a one-use link from noreply@; the new password works, the old sessions end, and a notice follows', async () => {
    const t = testApp()
    const kevin = await signUp(t, 'kevin@example.com')

    await askForReset(t, 'Kevin@Example.com')
    expect(sent).toHaveLength(1)
    const [reset] = sent
    expect(reset).toMatchObject({
      from: 'PestM8 <noreply@pestm8.com.au>',
      to: ['kevin@example.com'],
      subject: 'Reset your PestM8 password',
    })
    expect(reset.text).toContain('Hi Kevin,')
    expect(reset.text).toContain('http://localhost:3000/reset-password?token=')
    expect(reset.text).toContain('replies to it aren’t read')
    // Headed with the app's icon, from the app's own address.
    expect(reset.html).toContain('src="http://localhost:3000/icon-192.png"')

    const token = tokenIn(reset)
    const done = await browserOn(t).post('/reset-password', {
      newPassword: NEW_PASSWORD,
      token,
    })
    expect(done.status).toBe(200)

    // The session opened before the reset is gone.
    const session = await kevin.get('/get-session')
    expect(session.json).toBeNull()

    // The new password signs in; the old one no longer does.
    const fresh = browserOn(t)
    expect(
      (
        await fresh.post('/sign-in/email', {
          email: 'kevin@example.com',
          password: NEW_PASSWORD,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await browserOn(t).post('/sign-in/email', {
          email: 'kevin@example.com',
          password: PASSWORD,
        })
      ).status,
    ).toBe(401)

    // The link worked once.
    const again = await browserOn(t).post('/reset-password', {
      newPassword: 'yet another long password',
      token,
    })
    expect(again.status).toBe(400)

    // And the account holder is told.
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(sent.map((email) => email.subject)).toEqual([
      'Reset your PestM8 password',
      'Your PestM8 password was changed',
    ])
    expect(sent[1].text).toContain('http://localhost:3000/login')

    const rows = await t.run((ctx) => ctx.db.query('accountEmails').collect())
    expect(rows.map((row) => [row.kind, row.status])).toEqual([
      ['passwordReset', 'sent'],
      ['passwordChanged', 'sent'],
    ])
    // The row keeps what happened, never the link.
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  test('an address with no account is answered the same way, and nothing is sent', async () => {
    const t = testApp()
    const res = await browserOn(t).post('/request-password-reset', {
      email: 'nobody@example.com',
    })
    expect(res.status).toBe(200)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(sent).toEqual([])
  })

  test('one email per address per two minutes, and a handful a day', async () => {
    const t = testApp()
    await signUp(t, 'kevin@example.com')

    await askForReset(t, 'kevin@example.com')
    await askForReset(t, 'kevin@example.com')
    expect(sent).toHaveLength(1)

    for (let i = 1; i < RESETS_PER_DAY + 2; i++) {
      vi.advanceTimersByTime(3 * 60 * 1000)
      await askForReset(t, 'kevin@example.com')
    }
    expect(sent).toHaveLength(RESETS_PER_DAY)

    // A new day, a new allowance.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    await askForReset(t, 'kevin@example.com')
    expect(sent).toHaveLength(RESETS_PER_DAY + 1)
  })

  test('a deployment with no account sender sends nothing and says nothing different', async () => {
    vi.stubEnv('RESEND_ACCOUNT_FROM_EMAIL', '')
    const t = testApp()
    await signUp(t, 'kevin@example.com')
    await askForReset(t, 'kevin@example.com')
    expect(sent).toEqual([])
    expect(
      await t.run((ctx) => ctx.db.query('accountEmails').collect()),
    ).toEqual([])
  })

  test('a wrong or made-up token changes nothing', async () => {
    const t = testApp()
    await signUp(t, 'kevin@example.com')
    const res = await browserOn(t).post('/reset-password', {
      newPassword: NEW_PASSWORD,
      token: 'not-a-real-token',
    })
    expect(res.status).toBe(400)
  })
})

describe('the reset email', () => {
  test('escapes what it prints, and greets without a name', () => {
    const email = passwordResetEmail({
      url: 'https://app.pestm8.com.au/reset-password?token=a"b<c',
    })
    expect(email.text.startsWith('Hi,')).toBe(true)
    expect(email.html).not.toContain('a"b<c')
    expect(email.html).toContain('a&quot;b&lt;c')
  })
})

describe('the top of an account email', () => {
  test('is PestM8’s own mark, from the app’s address, not a business’s logo', () => {
    const email = passwordResetEmail({
      url: 'https://pestm8.vercel.app/reset-password?token=abc',
      markUrl: 'https://pestm8.vercel.app/icon-192.png',
    })
    expect(email.html).toContain(
      '<img src="https://pestm8.vercel.app/icon-192.png" width="36" height="36" alt=""',
    )
    expect(email.html).toContain('>PestM8</td>')
    // A deployment with no address of its own sends it without one.
    expect(
      passwordResetEmail({ url: 'https://x.test/reset-password?token=abc' })
        .html,
    ).not.toContain('<img')
  })

  test('goes dark where the mail app allows it', () => {
    const email = passwordChangedEmail({ signInUrl: 'https://x.test/login' })
    expect(email.html).toContain(
      '<meta name="color-scheme" content="light dark" />',
    )
    expect(email.html).toContain('@media (prefers-color-scheme: dark)')
  })
})

describe('account email asks nobody to write in', () => {
  const emails = {
    reset: passwordResetEmail({
      name: 'Kevin Walsh',
      url: 'https://app.pestm8.com.au/reset-password?token=abc',
    }),
    changed: passwordChangedEmail({
      name: 'Kevin Walsh',
      signInUrl: 'https://app.pestm8.com.au/login',
    }),
  }

  test.each(Object.entries(emails))(
    'the %s email says replies aren’t read, and gives no address to ask',
    (_, email) => {
      for (const body of [email.text, email.html]) {
        expect(body).toContain('replies to it aren’t read')
        expect(body).not.toMatch(/need help|get in touch|contact us/i)
        expect(body).not.toMatch(/[\w.+-]+@[\w-]+\.\w/)
      }
      expect(email.html).not.toContain('mailto:')
    },
  )

  test('a password nobody meant to change is fixed from the sign-in page', () => {
    expect(emails.changed.text).toContain(
      'If you didn’t change it, choose a new password straight away with “Forgot password?” on the sign-in page.',
    )
  })
})
