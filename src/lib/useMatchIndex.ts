import { useEffect, useMemo } from 'react'
import { areaCodeOf } from '../../convex/lib/contactKeys'
import { matchIndexFor, oursFor } from '../../convex/lib/clientMatch'
import { logConnectionSlower } from '#/lib/connectionLog'
import type {
  MatchIndex,
  MatchIndexOptions,
  OursSource,
} from '../../convex/lib/clientMatch'
import type { NormalisedDirectory } from '#/lib/directory'

type Business = {
  state: string
  phone?: string
  email?: string
  membership: { phone?: string }
}

type Member = {
  _id: string
  phone?: string
  email?: string
  status: 'active' | 'invited' | 'removed'
}

type Access = { membershipId: string; caps: { 'team.manage': boolean } }

const NO_MEMBERS: ReadonlyArray<Member> = []

/** How long each index took to build, as it was built; and those said. */
const builtIn = new WeakMap<MatchIndex, { rows: number; ms: number }>()
const said = new WeakSet<MatchIndex>()

/**
 * `matchIndexFor`, timed: an index built here (not one already made for
 * this answer) is noted with how many rows went into it and how long it
 * took, for `useLoggedBuild` to say once.
 */
function timedIndexFor(
  directory: NormalisedDirectory,
  opts: MatchIndexOptions,
): MatchIndex {
  const started = performance.now()
  const index = matchIndexFor(directory, opts)
  if (!builtIn.has(index)) {
    builtIn.set(index, {
      rows:
        directory.clients.length +
        directory.sites.length +
        directory.contacts.length,
      ms: performance.now() - started,
    })
  }
  return index
}

/**
 * The phone's notes say what an index cost (`match-index {rows, ms}`,
 * counts only, the matching plan's §2.12), after it is drawn: how slow a
 * push makes New Job on an old phone, without anything typed. Each index
 * once at most, and only one slower than any noted before
 * (`logConnectionSlower`): a busy business's pushes, all day, are not a note
 * each.
 */
function useLoggedBuild(index: MatchIndex | null): void {
  useEffect(() => {
    const built = index && builtIn.get(index)
    if (!index || !built || said.has(index)) return
    said.add(index)
    logConnectionSlower('match-index', built)
  }, [index])
}

/** The numbers and emails the index leaves out, for this reader
 * (`oursFor`). */
function useOurs(
  business: Business,
  members: ReadonlyArray<Member>,
  access: Access,
): OursSource {
  const self = members.find((m) => m._id === access.membershipId)
  const seesTeam = access.caps['team.manage']
  const selfPhone = self?.phone ?? business.membership.phone
  const selfEmail = self?.email
  return useMemo(
    () =>
      oursFor({
        business: { phone: business.phone, email: business.email },
        self: { phone: selfPhone, email: selfEmail },
        seesTeam,
        team: seesTeam ? members : null,
      }),
    [business.phone, business.email, selfPhone, selfEmail, seesTeam, members],
  )
}

/**
 * The match index over the client list (lib/clientMatch.ts), built once per
 * answer (`matchIndexFor`): what the pickers find a number or an email by.
 * Left out of it, as never anyone's own: the business's number and email,
 * the person's own, and, for someone who manages the team, every active
 * member's (`oursFor`). Anyone else passes only their own: the roster keeps
 * the team's numbers from them, and leaving those out would say which they
 * are.
 */
export function useMatchIndex(
  directory: NormalisedDirectory,
  business: Business,
  members: ReadonlyArray<Member>,
  access: Access,
): MatchIndex {
  const ours = useOurs(business, members, access)
  const index = useMemo(
    () =>
      timedIndexFor(directory, { areaCode: areaCodeOf(business.state), ours }),
    [directory, business.state, ours],
  )
  useLoggedBuild(index)
  return index
}

/**
 * `useMatchIndex` for a screen that reads the client list without waiting
 * for it (Clients → New client): null until it has the list, and, for
 * someone who manages the team, the roster too, so a team member's number
 * an office put on a client is never taken for the client's meanwhile.
 */
export function useMatchIndexWhenRead(
  directory: NormalisedDirectory | undefined,
  business: Business,
  members: ReadonlyArray<Member> | undefined,
  access: Access,
): MatchIndex | null {
  const ours = useOurs(business, members ?? NO_MEMBERS, access)
  const ready =
    directory !== undefined &&
    (members !== undefined || !access.caps['team.manage'])
  const index = useMemo(
    () =>
      ready
        ? timedIndexFor(directory, {
            areaCode: areaCodeOf(business.state),
            ours,
          })
        : null,
    [ready, directory, business.state, ours],
  )
  useLoggedBuild(index)
  return index
}
