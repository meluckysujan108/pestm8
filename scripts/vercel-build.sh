#!/usr/bin/env bash
#
# Vercel's Build Command. Lives in the repository rather than in a dashboard
# text box so it is reviewable, diffable, and identical in every environment.
#
#   Vercel → Project Settings → Build & Development Settings
#   Build Command: bash scripts/vercel-build.sh
#
# Which Convex deployment this touches is decided entirely by CONVEX_DEPLOY_KEY,
# which is set per-environment in Vercel. See DEPLOYMENT.md — putting the
# production key in the Preview environment would make every pull request
# deploy onto the live database.
set -euo pipefail

echo "VERCEL_ENV=${VERCEL_ENV:-unset}"

if [ "${VERCEL_ENV:-}" = "preview" ]; then
  # Preview builds share one staging Convex deployment, and Better Auth accepts
  # exactly one origin: convex/auth.ts sets `baseURL` from SITE_URL and does not
  # set trustedOrigins. VERCEL_BRANCH_URL is stable per branch (unlike
  # VERCEL_URL, which changes every deployment), so staging is pointed at the
  # branch being built. With one developer the branch you are looking at is
  # always the last one built; with two, the later build wins and the other
  # preview cannot sign in until it is rebuilt.
  if [ -z "${VERCEL_BRANCH_URL:-}" ]; then
    echo "✖ VERCEL_BRANCH_URL is empty — cannot point staging at this branch." >&2
    echo "  Sign-in on the preview will fail. See DEPLOYMENT.md." >&2
    exit 1
  fi
  echo "Pointing the staging deployment's SITE_URL at https://${VERCEL_BRANCH_URL}"
  npx convex env set SITE_URL "https://${VERCEL_BRANCH_URL}"
fi

# Deploys the Convex backend, then runs the frontend build against it. Both
# halves of the release move together: there is no window where new frontend
# code is live against old backend functions.
npx convex deploy --cmd 'pnpm run build'
