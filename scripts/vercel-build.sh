#!/usr/bin/env bash
#
# Vercel's Build Command. Lives in the repository rather than a dashboard text
# box so it is reviewable, diffable, and identical in every environment.
#
#   Vercel → Project Settings → Build & Deployment
#   Build Command: bash scripts/vercel-build.sh
#
# Which Convex deployment this touches is decided entirely by CONVEX_DEPLOY_KEY,
# set per-environment in Vercel:
#
#   Preview    → a PREVIEW deploy key. Convex creates a fresh, empty deployment
#                named after the git branch, so a pull request cannot reach real
#                data — it is not in the same database.
#   Production → the PRODUCTION deploy key.
#
# Putting the production key on the Preview row would make every pull request
# deploy onto the live database. See DEPLOYMENT.md.
set -euo pipefail

echo "VERCEL_ENV=${VERCEL_ENV:-unset}"

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  echo "✖ CONVEX_DEPLOY_KEY is not set for this environment." >&2
  echo "  Vercel → Settings → Environment Variables: a preview deploy key on" >&2
  echo "  Preview, the production key on Production. See DEPLOYMENT.md." >&2
  exit 1
fi

# One command deploys the backend and builds the frontend against it, so the two
# halves of a release move together — there is no window where new frontend code
# is live against old backend functions.
#
# --cmd-url-env-var-name is what makes preview deployments usable at all: the
# deployment is created during this command, so its URL cannot be configured in
# advance and has to be injected into the build.
exec npx convex deploy \
  --cmd-url-env-var-name VITE_CONVEX_URL \
  --cmd 'bash scripts/build.sh'
