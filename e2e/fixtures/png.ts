import { deflateSync } from 'node:zlib'

/**
 * A real PNG, at whatever size a spec needs.
 *
 * The 1x1 fixture most specs use is fine for "did an upload happen", and
 * useless for anything that depends on what the image IS: the annotation
 * canvas sizes itself to `min(naturalWidth, 640)`, so a 1x1 source stays 1x1
 * and a 20%→80% drag spans less than a pixel; and a square tells you nothing
 * about whether a photo's shape survived the trip.
 *
 * No image library is a devDependency here — and one cannot be hand-rolled for
 * JPEG, which needs DCT and Huffman tables — but PNG is deflate plus CRC, so a
 * valid one can be built directly: IHDR, one IDAT of unfiltered scanlines,
 * IEND.
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

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

/** A solid-colour PNG of the given size, in RGB at 8 bits per channel. */
export function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number] = [80, 140, 80],
): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  const stride = 1 + width * 3
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
    }
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
