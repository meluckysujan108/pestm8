#!/usr/bin/env bash
#
# The build, wrapped so `convex deploy --cmd` can call it.
#
# `--cmd-url-env-var-name VITE_CONVEX_URL` hands this script the deployment's
# .cloud address — including, on a preview build, the address of a deployment
# Convex has just created for this branch, whose name nobody could have known
# in advance. That makes this the only point in the build where the preview
# deployment's identity is known, which is why the SITE_URL step below lives
# here rather than in vercel-build.sh.
#
# A file rather than an inline --cmd string: it can be run directly to test it,
# and it does not depend on which shell Convex picks to run the command.
set -euo pipefail

if [ -z "${VITE_CONVEX_URL:-}" ]; then
  echo "✖ VITE_CONVEX_URL is not set." >&2
  echo "  Under 'convex deploy' it comes from --cmd-url-env-var-name;" >&2
  echo "  locally it comes from .env.local. See DEPLOYMENT.md." >&2
  exit 1
fi

# Same deployment, different domain — .site is where convex/http.ts mounts the
# Better Auth routes. Only fills a value that isn't already set, so an
# explicitly configured address still wins.
if [ -z "${VITE_CONVEX_SITE_URL:-}" ]; then
  VITE_CONVEX_SITE_URL="${VITE_CONVEX_URL%.convex.cloud}.convex.site"
  export VITE_CONVEX_SITE_URL
  echo "Derived VITE_CONVEX_SITE_URL=${VITE_CONVEX_SITE_URL}"
fi

# Better Auth accepts exactly one origin: convex/auth.ts sets baseURL from
# SITE_URL. A preview deployment is brand new and has no SITE_URL, so sign-in
# on the preview would bounce to /login until it is told which origin it serves.
# VERCEL_BRANCH_URL is stable per branch, unlike VERCEL_URL.
#
# Production is deliberately untouched: its SITE_URL is already correct, and
# rewriting it on every deploy is a way to break sign-in, not to fix it.
if [ "${VERCEL_ENV:-}" = "preview" ] && [ -n "${VERCEL_BRANCH_URL:-}" ]; then
  deployment="${VITE_CONVEX_URL#https://}"
  deployment="${deployment%.convex.cloud}"
  echo "Pointing preview deployment ${deployment} at https://${VERCEL_BRANCH_URL}"
  # Not fatal: a preview whose pages build but whose sign-in is misconfigured
  # is still worth shipping, provided the log says so rather than staying quiet.
  if ! npx convex env set --deployment "$deployment" \
    SITE_URL "https://${VERCEL_BRANCH_URL}"; then
    echo "⚠ Could not set SITE_URL on ${deployment}." >&2
    echo "  The preview will build, but signing in on it will bounce to /login." >&2
    echo "  See DEPLOYMENT.md." >&2
  fi
fi

exec pnpm run build
