/**
 * Pixels shaped like a phone photo, for the tests of a big report's email
 * copy: smooth light across the frame with grain on top, which is what makes
 * a real one hard to compress. Seeded, so every run makes the same picture.
 *
 * Out here rather than in convex/, where anything is bundled and deployed.
 */
export function photoLike(
  width: number,
  height: number,
  seed = 1,
): { data: Uint8ClampedArray; width: number; height: number } {
  let state = seed
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const light =
        90 + 80 * Math.sin((x + seed * 40) / 170) * Math.cos(y / 230)
      const grain = (random() - 0.5) * 38
      data[i] = light + grain + 20
      data[i + 1] = light + grain
      data[i + 2] = light * 0.8 + grain - 10
      data[i + 3] = 255
    }
  }
  return { data, width, height }
}
