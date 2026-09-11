# Runbook

The thing to read when production is broken. Symptoms first.

## The asymmetry to know before you need it

Rolling back the **frontend** takes about ten seconds. Rolling back the
**backend** does not. Convex function code can be redeployed from an older
commit easily enough, but a _schema_ change that has already rewritten
documents cannot be undone by redeploying — it needs a restore from a snapshot,
and everything written since that snapshot is lost.

So: frontend problems are cheap, schema problems are expensive. Treat them
differently.

## What already protects you

Convex validates every existing document against the new schema at deploy time
and **refuses the deploy** if any row doesn't conform. A breaking schema change
fails loudly at deploy rather than corrupting data. This is a real guarantee and
it is why the rule below is "additive first" rather than "be careful".

---

## Symptom: the site is broken after a deploy

1. **Vercel → Deployments → the last good one → Promote to Production.** The
   frontend is back.
2. Then revert the commit on `main` through a pull request, so `main` and
   production agree again. Every pull request is squash-merged, so this is one
   `git revert` of one commit.

Promoting an old deployment does **not** roll back Convex. If the bad deploy
changed backend functions, step 2 is what actually fixes it — the merge
redeploys Convex.

## Symptom: sign-in bounces back to /login

Almost always `SITE_URL` on the Convex deployment no longer matches the origin
the frontend is served from. Check it matches exactly — scheme, host, no
trailing slash:

```bash
npx convex env get SITE_URL
```

This has caused one production outage already (commit `18704ea`) and is the
single most likely thing to recur. It happens whenever the origin moves: a
custom domain, a new host, a renamed project.

## Symptom: blank page, console says a VITE_ variable is not set

The build ran without the variable inlined. Redeploying the same artifact will
not fix it — the value is baked into the bundle. Set it in the Vercel
environment and trigger a **new build**.

## Symptom: data is wrong or missing

1. **Stop writes** if you can — the longer the app runs, the more is lost.
2. Find the most recent snapshot: GitHub → Actions → _Backup production_ → the
   latest run → the `convex-prod-*` artifact. They are kept 30 days.
3. Restore it:

```bash
npx convex import --prod --replace snapshot.zip
```

4. Accept that everything written between the snapshot and now is gone, and
   tell whoever is affected.

`--replace` overwrites the tables in the archive. Read
`npx convex import --help` before running it against production; this is the
one command in this repository that destroys data.

## Deploying a schema change safely

The rule, in `CONTRIBUTING.md` too: **additive first.** Add optional fields;
never rename or retype a field in one step. The three-step version is:

1. Add the new field as optional. Deploy. Backfill.
2. Switch readers to the new field. Deploy.
3. Make it required and drop the old one. Deploy.

For the backfill, add `@convex-dev/migrations` — it is not a dependency yet
because no non-additive change has needed it. Take a manual snapshot first:

```bash
npx convex export --prod --path pre-migration.zip
```

## Fire drill

A backup nobody has restored is a hope, not a backup. Once — and again after
any change to the backup workflow — download an artifact and import it into
the staging project, then load the app against it. Doing this while there is
no customer data to lose is free; doing it for the first time during an
incident is not.
