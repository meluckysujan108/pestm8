/* Xero (Release 1), as `xero.status` and `xero.memberStatus` answer it, for
 * the Settings → Xero / My Xero specimens and the Team page's Xero line.
 *
 * `xero.status` is keyed by business id, so each specimen asks for a
 * business of its own and gets one state: the real page, with one answer.
 * Shaped like `XeroView` in convex/xero.ts — read it, don't guess. */

const HOUR = 60 * 60 * 1000

/** The businesses the specimens ask for, one state each. */
export const XERO_BIZ = {
  none: 'biz_xero_none',
  connected: 'biz_xero_connected',
  reconnect: 'biz_xero_reconnect',
  leftover: 'biz_xero_leftover',
  unconfigured: 'biz_xero_unconfigured',
  demo: 'biz_xero_demo',
  /** Two-step sign-in is off, which Connect needs. */
  twoStepOff: 'biz_xero_two_step_off',
  /** Never answers: the page's placeholder. */
  loading: 'biz_xero_loading',
} as const

function view(
  kind: 'business' | 'member',
  status: 'pending' | 'connected' | 'needs_reconnect' | 'disconnected',
  extra: Partial<{
    problem: { code: string; at: number } | null
    disconnectReason: string | null
  }> = {},
) {
  return {
    connectionId: `xc_${kind}_${status}`,
    kind,
    tenantName:
      kind === 'business' ? 'Pest M8 Pest Control' : 'Doyle Pest Services',
    status,
    connectedAt: Date.now() - 26 * HOUR,
    connectedByName: kind === 'business' ? 'Terence Walsh' : 'Kevin Doyle',
    problem: null,
    shortCode: '!x7Kp2',
    disconnectReason: null,
    ...extra,
  }
}

function statusFor(businessId: string) {
  const base = {
    configured: true,
    paused: false,
    demo: false,
    switched: false,
    isOwner: true,
    twoStepOn: true,
    timezone: 'Australia/Perth',
    business: null as ReturnType<typeof view> | null,
    mine: null as ReturnType<typeof view> | null,
  }
  switch (businessId) {
    case XERO_BIZ.loading:
      return undefined
    case XERO_BIZ.unconfigured:
      return { ...base, configured: false }
    case XERO_BIZ.demo:
      return { ...base, demo: true }
    case XERO_BIZ.twoStepOff:
      return { ...base, twoStepOn: false }
    case XERO_BIZ.connected:
      return {
        ...base,
        business: view('business', 'connected'),
        mine: view('member', 'connected'),
      }
    case XERO_BIZ.reconnect:
      return {
        ...base,
        business: view('business', 'needs_reconnect', {
          problem: { code: 'reconnect', at: Date.now() - 3 * HOUR },
        }),
        mine: view('member', 'needs_reconnect', {
          problem: { code: 'reconnect', at: Date.now() - 3 * HOUR },
        }),
      }
    case XERO_BIZ.leftover:
      return {
        ...base,
        business: view('business', 'disconnected', {
          problem: { code: 'xero_side', at: Date.now() - HOUR },
          disconnectReason: 'by_hand',
        }),
      }
    // Everything else — the Team page's business (`BIZ`) among them — is set
    // up for Xero, with nothing connected.
    default:
      return base
  }
}

/** The Team page's members, one Xero state each (`MEMBERS` in fixtures). */
function memberStatusFor(membershipId: string) {
  switch (membershipId) {
    case 'm_kev':
      return {
        status: 'connected',
        tenantName: 'Doyle Pest Services',
        connectedAt: Date.now() - 26 * HOUR,
      }
    case 'm_sam':
      return {
        status: 'needs_reconnect',
        tenantName: 'Nguyen Pest & Termite',
        connectedAt: Date.now() - 40 * 24 * HOUR,
      }
    default:
      return null
  }
}

export const XERO_FIXTURES: Record<string, (args: never) => unknown> = {
  'xero:status': (args: { businessId: string }) => statusFor(args.businessId),
  'xero:memberStatus': (args: { membershipId: string }) =>
    memberStatusFor(args.membershipId),
}
