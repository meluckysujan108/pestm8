import { postcodeStateHint } from '#/lib/addressLookup'

/**
 * A quiet line under the state and postcode when the postcode is another
 * state's (Prompt 6.2), with a one-tap fix. Prod has "Darwin 2209" and
 * "Fannybay WA 0810": the state is a dropdown that starts on the business's
 * own, and nobody looks at it while typing an address.
 *
 * A hint and never a block. A few border towns really do use the neighbour's
 * postcodes (Barooga NSW is 3644), so the form saves whatever is chosen.
 */
export function PostcodeStateHint({
  postcode,
  state,
  onUseState,
}: {
  postcode: string
  state: string
  onUseState: (state: string) => void
}) {
  const hint = postcodeStateHint(postcode, state)
  if (!hint) return null
  return (
    <p className="mt-1.5 text-caption text-muted">
      {hint.message}{' '}
      <button
        type="button"
        onClick={() => onUseState(hint.state)}
        className="font-semibold text-blue"
      >
        Use {hint.state}
      </button>
    </p>
  )
}
