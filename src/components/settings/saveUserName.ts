/**
 * Kept apart from MyDetails so it can be tested on its own: the
 * component's imports reach the server-side auth setup, which needs the
 * deployment's environment at load and has none under the unit tests.
 */

/** What Better Auth's client resolves with: a refusal comes back as `error`
 * rather than being thrown. */
type UpdateUserResult = {
  error?: { message?: string; status?: number } | null
} | null

/**
 * Saves the person's name, and fails when it did not save.
 *
 * Better Auth's client does not throw when the server refuses — an expired
 * session, a 4xx — it resolves with `{ error }`. Taken as it came, that read
 * as success: the button said "Saved" over a name that had not changed, and
 * FormAlert never showed. So a refusal is thrown here, for the form to say.
 *
 * A name left as it was is not sent at all. The Save button also saves the
 * phone number, and a name round trip that could fail on its own would stop
 * that save for no change.
 */
export async function saveUserName(
  next: string,
  saved: string,
  update: (args: { name: string }) => Promise<UpdateUserResult>,
): Promise<void> {
  if (next === saved) return
  const result = await update({ name: next })
  const error = result?.error
  if (!error) return
  // Signed out is the likely one, and FormAlert has words for it.
  if (error.status === 401) throw new Error('UNAUTHENTICATED')
  throw new Error(error.message || 'NAME_NOT_SAVED')
}
