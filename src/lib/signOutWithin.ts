/**
 * A sign-out request, given `ms` to land: Settings' Sign out, which says so
 * when it can't (settings/index.tsx).
 *
 * Better Auth answers a request that reached the server but failed with
 * `error`, and throws when it never got there. `inTime` is whether the
 * server ended the session within `ms`. `landed` settles with the request,
 * however long it takes, true once the server has ended the session: a
 * request given up on isn't stopped, and one that lands late has still
 * signed the person out, so the page must still finish the sign-out then.
 */
export async function signOutWithin(
  request: Promise<{ error: unknown }>,
  ms: number,
): Promise<{ inTime: boolean; landed: Promise<boolean> }> {
  const landed = request.then(
    (result) => !result.error,
    () => false,
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const inTime = await Promise.race([
    landed,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => clearTimeout(timer))
  return { inTime, landed }
}
