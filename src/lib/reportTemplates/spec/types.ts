/**
 * The shape of the extracted verbatim corpus (see
 * `scripts/extract-form-strings.mjs`). One entry per string the source forms
 * print or offer, with a citation back to the document it came from, so the
 * fidelity test can name the source when it fails.
 */
export type SourceString = {
  /** The string exactly as the source has it. */
  text: string
  kind: 'heading' | 'label' | 'option' | 'note' | 'printed'
  /** `file:line` for a markdown source, `file:pN` for the printed PDF. */
  cite: string
}
