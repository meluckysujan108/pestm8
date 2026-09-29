/**
 * The pixel size of a PNG, JPEG, GIF or WebP, read from its header.
 *
 * For a logo stored before its email copy was (lib/businessLogo.ts), which a
 * report email still has to give a width and a height: Outlook for Windows
 * ignores a CSS size on an image and draws it at its own, and an 800px logo
 * across the top of an email is what that looks like.
 *
 * Only the header is read and nothing is decoded, so a truncated or unknown
 * file is null rather than an error.
 */
export type ImageSize = {
  width: number
  height: number
  format: 'png' | 'gif' | 'webp' | 'jpeg'
}

export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) return null

  // PNG: the signature, then IHDR's width and height, big-endian.
  if (ascii(bytes, 1, 3) === 'PNG' && bytes[0] === 0x89) {
    return sized('png', u32be(bytes, 16), u32be(bytes, 20))
  }

  // GIF: "GIF87a" or "GIF89a", then the logical screen, little-endian.
  if (ascii(bytes, 0, 4) === 'GIF8') {
    return sized('gif', u16le(bytes, 6), u16le(bytes, 8))
  }

  // WebP: a RIFF container holding one of three first chunks.
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4)
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      return sized('webp', u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff)
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f && bytes.length >= 25) {
      const b = bytes
      return sized(
        'webp',
        1 + (((b[22] & 0x3f) << 8) | b[21]),
        1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
      )
    }
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return sized('webp', 1 + u24le(bytes, 24), 1 + u24le(bytes, 27))
    }
    return null
  }

  // JPEG: markers after the start of image, up to the first start of frame.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1]
      // Fill bytes before a marker.
      if (marker === 0xff) {
        at += 1
        continue
      }
      // Markers that stand alone, with no length after them.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2
        continue
      }
      // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return sized('jpeg', u16be(bytes, at + 7), u16be(bytes, at + 5))
      }
      at += 2 + u16be(bytes, at + 2)
    }
    return null
  }

  return null
}

function sized(
  format: ImageSize['format'],
  width: number,
  height: number,
): ImageSize | null {
  return width > 0 && height > 0 ? { width, height, format } : null
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length))
}

function u16be(bytes: Uint8Array, at: number) {
  return (bytes[at] << 8) | bytes[at + 1]
}

function u16le(bytes: Uint8Array, at: number) {
  return bytes[at] | (bytes[at + 1] << 8)
}

function u24le(bytes: Uint8Array, at: number) {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
}

function u32be(bytes: Uint8Array, at: number) {
  return (
    ((bytes[at] << 24) >>> 0) +
    ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3])
  )
}
