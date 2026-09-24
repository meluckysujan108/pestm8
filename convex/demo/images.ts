/**
 * Pictures for the demo business: a logo, drawn signatures and site photos,
 * made here rather than shipped as files. Real PNGs — the report PDF
 * (@react-pdf) draws PNG and JPEG and nothing else — encoded in plain
 * TypeScript so the seed runs in Convex's default runtime: no Node, no zlib.
 * The pixel data goes in uncompressed ("stored") deflate blocks, which every
 * PNG decoder reads; the files are larger than they need be, and nothing
 * here is large.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function u32(n: number): Array<number> {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const body = new Uint8Array(typeBytes.length + data.length)
  body.set(typeBytes, 0)
  body.set(data, typeBytes.length)
  const out = new Uint8Array(12 + data.length)
  out.set(u32(data.length), 0)
  out.set(body, 4)
  out.set(u32(crc32(body)), 8 + data.length)
  return out
}

/** A zlib stream of stored (uncompressed) deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const MAX = 65535
  const blocks = Math.max(1, Math.ceil(raw.length / MAX))
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  out[0] = 0x78
  out[1] = 0x01
  let o = 2
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX
    const len = Math.min(MAX, raw.length - start)
    out[o++] = i === blocks - 1 ? 1 : 0
    out[o++] = len & 0xff
    out[o++] = (len >>> 8) & 0xff
    out[o++] = ~len & 0xff
    out[o++] = (~len >>> 8) & 0xff
    out.set(raw.subarray(start, start + len), o)
    o += len
  }
  out.set(u32(adler32(raw)), o)
  return out
}

/** An 8-bit RGBA PNG. `pixel(x, y)` returns [r, g, b, a]. */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): Uint8Array<ArrayBuffer> {
  const raw = new Uint8Array(height * (1 + width * 4))
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
      raw[o++] = a
    }
  }
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0])
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

/** The business logo: a green disc with a white leaf-ish band. */
export function logoPng(): Uint8Array<ArrayBuffer> {
  const size = 192
  const c = size / 2
  return encodePng(size, size, (x, y) => {
    const d = Math.hypot(x - c, y - c)
    if (d > c - 2) return [255, 255, 255, 0]
    const band = Math.abs(y - c - Math.sin((x / size) * Math.PI * 2) * 18) < 14
    return band ? [255, 255, 255, 255] : [22, 128, 74, 255]
  })
}

/**
 * A drawn signature: one continuous stroke in ink on a clear background,
 * shaped by `seed` so each person's differs.
 */
export function signaturePng(seed: number): Uint8Array<ArrayBuffer> {
  const width = 360
  const height = 120
  const points: Array<[number, number]> = []
  for (let t = 0; t <= 1; t += 0.0015) {
    const x = 20 + t * 320
    const y =
      60 +
      Math.sin(t * Math.PI * (4 + seed)) * (26 - seed * 2) +
      Math.sin(t * Math.PI * (9 + seed * 2)) * 10 * Math.cos(t * 3)
    points.push([x, y])
  }
  const ink = new Uint8Array(width * height)
  for (const [px, py] of points) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy > 5) continue
        const x = Math.round(px + dx)
        const y = Math.round(py + dy)
        if (x >= 0 && x < width && y >= 0 && y < height) ink[y * width + x] = 1
      }
    }
  }
  return encodePng(width, height, (x, y) =>
    ink[y * width + x] ? [20, 30, 70, 255] : [255, 255, 255, 0],
  )
}

/**
 * A "site photo": a sky-to-ground scene with a building and a doorway, in a
 * palette chosen by `seed`. Stand-ins, but real images at a real size, so
 * galleries, covers and the PDF lay them out as they would a photograph.
 */
export function photoPng(
  seed: number,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const palettes: Array<[number, number, number]> = [
    [120, 170, 220],
    [200, 150, 110],
    [110, 160, 120],
    [170, 130, 190],
    [210, 190, 120],
    [120, 190, 190],
  ]
  const [r0, g0, b0] = palettes[seed % palettes.length]
  const horizon = Math.round(height * (0.45 + (seed % 3) * 0.05))
  const left = Math.round(width * 0.2)
  const right = Math.round(width * 0.75)
  const roof = Math.round(horizon - height * 0.28)
  return encodePng(width, height, (x, y) => {
    const doorway =
      x > (left + right) / 2 - width * 0.05 &&
      x < (left + right) / 2 + width * 0.05 &&
      y > horizon - height * 0.18 &&
      y < horizon
    if (doorway) return [60, 40, 30, 255]
    if (x >= left && x <= right && y >= roof && y < horizon) {
      const shade = ((x - left) / (right - left)) * 30
      return [
        clamp(r0 * 0.9 + shade),
        clamp(g0 * 0.8 + shade),
        clamp(b0 * 0.7 + shade),
        255,
      ]
    }
    if (y < horizon) {
      const t = y / horizon
      return [
        clamp(170 + 60 * t),
        clamp(200 + 40 * t),
        clamp(240 - 10 * t),
        255,
      ]
    }
    const t = (y - horizon) / (height - horizon)
    return [
      clamp(r0 * 0.5 + 40 * t),
      clamp(g0 * 0.6 + 30 * t),
      clamp(b0 * 0.4 + 20 * t),
      255,
    ]
  })
}

/** The site photos the seed stores: landscape and portrait mixed. */
export const PHOTO_SPECS: Array<{
  seed: number
  width: number
  height: number
}> = [
  { seed: 0, width: 400, height: 300 },
  { seed: 1, width: 400, height: 300 },
  { seed: 2, width: 300, height: 400 },
  { seed: 3, width: 400, height: 300 },
  { seed: 4, width: 300, height: 400 },
  { seed: 5, width: 400, height: 300 },
  { seed: 6, width: 400, height: 300 },
  { seed: 7, width: 300, height: 400 },
]
