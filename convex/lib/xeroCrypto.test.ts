import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
} from './base64'
import {
  accessAad,
  decryptToken,
  encryptToken,
  refreshAad,
  tokenKeyVersions,
} from './xeroCrypto'

/** Two fixed 32-byte keys, as `openssl rand -base64 32` would print them. */
const KEY_1 = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
const KEY_2 = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => 200 - i))

/** Shaped like a Xero access token: long, dotted, base64url. */
const TOKEN =
  'eyJhbGciOiJSUzI1NiJ9.eyJ4ZXJvX3VzZXJpZCI6Ijk5In0.c2lnbmF0dXJlLXRleHQtaGVyZQ'

function keys(value: string) {
  vi.stubEnv('XERO_TOKEN_KEYS', value)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('base64', () => {
  test('round trips every byte value in both alphabets', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes])
    expect([...base64UrlToBytes(bytesToBase64Url(bytes))]).toEqual([...bytes])
  })

  test('the URL-safe form has no +, / or padding', () => {
    const encoded = bytesToBase64Url(Uint8Array.from([251, 255, 191, 0]))
    expect(encoded).not.toMatch(/[+/=]/)
  })

  test('the URL-safe reader also takes standard, padded base64', () => {
    const bytes = Uint8Array.from([251, 255, 191, 7, 9])
    expect([...base64UrlToBytes(bytesToBase64(bytes))]).toEqual([...bytes])
  })

  test('rejects what is not base64', () => {
    expect(() => base64UrlToBytes('a')).toThrow()
    expect(() => base64UrlToBytes('no spaces!')).toThrow()
  })
})

describe('encryptToken / decryptToken', () => {
  test('round trips under the same AAD', async () => {
    keys(`1:${KEY_1}`)
    const cipher = await encryptToken(TOKEN, accessAad('xu-1'))
    expect(await decryptToken(cipher, accessAad('xu-1'))).toBe(TOKEN)
  })

  test('the cipher is x1.<version>.<iv>.<sealed>, and hides the token', async () => {
    keys(`1:${KEY_1}`)
    const cipher = await encryptToken(TOKEN, accessAad('xu-1'))
    const parts = cipher.split('.')
    expect(parts).toHaveLength(4)
    expect(parts.slice(0, 2)).toEqual(['x1', '1'])
    expect(base64UrlToBytes(parts[2])).toHaveLength(12)
    expect(cipher).not.toContain(TOKEN)
    expect(cipher).not.toContain(TOKEN.split('.')[1])
  })

  test('a fresh IV every time: the same token never seals the same way', async () => {
    keys(`1:${KEY_1}`)
    const a = await encryptToken(TOKEN, accessAad('xu-1'))
    const b = await encryptToken(TOKEN, accessAad('xu-1'))
    expect(a).not.toBe(b)
    expect(a.split('.')[2]).not.toBe(b.split('.')[2])
  })

  test('round trips text beyond ASCII', async () => {
    keys(`1:${KEY_1}`)
    const plain = 'Kévin’s token — ✓'
    const cipher = await encryptToken(plain, refreshAad('xu-1'))
    expect(await decryptToken(cipher, refreshAad('xu-1'))).toBe(plain)
  })

  test('an altered cipher is unreadable, wherever it was altered', async () => {
    keys(`1:${KEY_1}`)
    const cipher = await encryptToken(TOKEN, accessAad('xu-1'))
    const [format, version, iv, sealed] = cipher.split('.')
    const flip = (s: string, at: number) =>
      s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1)

    const altered = [
      [format, version, iv, flip(sealed, 5)],
      [format, version, iv, flip(sealed, sealed.length - 2)],
      [format, version, flip(iv, 3), sealed],
      [format, version, iv, sealed.slice(0, -4)],
      [format, version, iv.slice(0, -2), sealed],
      ['x2', version, iv, sealed],
      [format, version, iv],
      [format, version, iv, sealed, 'extra'],
    ].map((parts) => parts.join('.'))

    for (const bad of [...altered, '', 'not a cipher', TOKEN]) {
      await expect(decryptToken(bad, accessAad('xu-1'))).rejects.toThrow(
        'XERO_TOKEN_UNREADABLE',
      )
    }
  })

  test('the wrong AAD is unreadable: other slot, other Xero user', async () => {
    keys(`1:${KEY_1}`)
    const cipher = await encryptToken(TOKEN, accessAad('xu-1'))
    await expect(decryptToken(cipher, refreshAad('xu-1'))).rejects.toThrow(
      'XERO_TOKEN_UNREADABLE',
    )
    await expect(decryptToken(cipher, accessAad('xu-2'))).rejects.toThrow(
      'XERO_TOKEN_UNREADABLE',
    )
  })

  test('the wrong key under the same version is unreadable', async () => {
    keys(`1:${KEY_1}`)
    const cipher = await encryptToken(TOKEN, accessAad('xu-1'))
    keys(`1:${KEY_2}`)
    await expect(decryptToken(cipher, accessAad('xu-1'))).rejects.toThrow(
      'XERO_TOKEN_UNREADABLE',
    )
  })

  test('a version no longer listed is unreadable', async () => {
    keys(`1:${KEY_1}`)
    const cipher = await encryptToken(TOKEN, accessAad('xu-1'))
    keys(`2:${KEY_2}`)
    await expect(decryptToken(cipher, accessAad('xu-1'))).rejects.toThrow(
      'XERO_TOKEN_UNREADABLE',
    )
  })
})

describe('key rotation', () => {
  test('a new key seals new tokens; the old one still opens old ones', async () => {
    keys(`1:${KEY_1}`)
    const old = await encryptToken(TOKEN, refreshAad('xu-1'))

    keys(`2:${KEY_2},1:${KEY_1}`)
    expect(tokenKeyVersions()).toEqual([2, 1])
    expect(await decryptToken(old, refreshAad('xu-1'))).toBe(TOKEN)

    const resealed = await encryptToken(TOKEN, refreshAad('xu-1'))
    expect(resealed.split('.').slice(0, 2)).toEqual(['x1', '2'])
    expect(await decryptToken(resealed, refreshAad('xu-1'))).toBe(TOKEN)

    // Once the old key is dropped, only what was re-sealed opens.
    keys(`2:${KEY_2}`)
    expect(await decryptToken(resealed, refreshAad('xu-1'))).toBe(TOKEN)
    await expect(decryptToken(old, refreshAad('xu-1'))).rejects.toThrow(
      'XERO_TOKEN_UNREADABLE',
    )
  })

  test('the first entry seals, whatever its number', async () => {
    keys(`1:${KEY_1},2:${KEY_2}`)
    const cipher = await encryptToken(TOKEN, accessAad('xu-1'))
    expect(cipher.split('.')[1]).toBe('1')
  })

  test('takes padding-free and URL-safe keys, and spaces around entries', async () => {
    const urlSafe = KEY_2.replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
    keys(` 3:${urlSafe} , 1:${KEY_1} `)
    expect(tokenKeyVersions()).toEqual([3, 1])
    const cipher = await encryptToken(TOKEN, accessAad('xu-1'))
    expect(await decryptToken(cipher, accessAad('xu-1'))).toBe(TOKEN)
  })
})

describe('XERO_TOKEN_KEYS that will not parse', () => {
  const short = bytesToBase64(new Uint8Array(16))
  const long = bytesToBase64(new Uint8Array(33))
  const malformed = [
    '',
    ' , ',
    KEY_1,
    `:${KEY_1}`,
    `0:${KEY_1}`,
    `-1:${KEY_1}`,
    `v1:${KEY_1}`,
    `1.5:${KEY_1}`,
    '1:',
    '1:not base64!',
    `1:${short}`,
    `1:${long}`,
    `1:${KEY_1},1:${KEY_2}`,
    `2:${KEY_2},${KEY_1}`,
  ]

  test.each(malformed)('%j → XERO_KEYS_INVALID', async (value) => {
    keys(value)
    expect(() => tokenKeyVersions()).toThrow('XERO_KEYS_INVALID')
    await expect(encryptToken(TOKEN, accessAad('xu-1'))).rejects.toThrow(
      'XERO_KEYS_INVALID',
    )
    await expect(decryptToken('x1.1.a.b', accessAad('xu-1'))).rejects.toThrow(
      'XERO_KEYS_INVALID',
    )
  })

  test('unset → XERO_KEYS_INVALID', () => {
    vi.stubEnv('XERO_TOKEN_KEYS', undefined)
    expect(() => tokenKeyVersions()).toThrow('XERO_KEYS_INVALID')
  })

  test('the error never carries the key', () => {
    keys(`1:${KEY_1},1:${KEY_2}`)
    let message = ''
    try {
      tokenKeyVersions()
    } catch (error) {
      message = `${String(error)} ${JSON.stringify(error)}`
    }
    expect(message).toContain('XERO_KEYS_INVALID')
    expect(message).not.toContain(KEY_1)
    expect(message).not.toContain(KEY_2)
  })
})
