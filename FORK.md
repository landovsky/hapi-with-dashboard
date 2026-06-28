# Fork notes — hapi-with-dashboard

This repo is a **fork/derivative of [`tiann/hapi`](https://github.com/tiann/hapi)**
that adds a mobile-first **voice dashboard** (`/dashboard` + `/voice/:id`) and a
small additive hub backend. It's maintained to be **deployed** (see
[`DEPLOY-k3s.md`](./DEPLOY-k3s.md)), not primarily to send PRs back upstream.

> Note: this was pushed as a standalone repo, not a GitHub‑native fork, so the
> grey "Sync fork" button isn't available — sync with the git commands below.

## How it's set up

- **`origin`** → `git@github.com:landovsky/hapi-with-dashboard.git` (your repo)
- **`upstream`** → `https://github.com/tiann/hapi` (the original, read‑only to you)
- **`main`** → your line of record. It carries upstream's history **plus** your
  changes, and it's what you deploy. This is the default branch.

Check your remotes any time with `git remote -v`.

## Keep `main` clean — never commit straight to it

Do every change on a short‑lived **topic branch**, then merge it back. This keeps
`main` always-deployable and makes upstream syncs painless.

```bash
git switch -c feat/my-change       # branch off main
# …edit, commit…
git switch main
git merge --no-ff feat/my-change   # bring it in (a merge commit documents the feature)
git push origin main
git branch -d feat/my-change       # delete the merged branch
```

(Your existing work was fast‑forwarded onto `main`, so there's nothing to merge
for the dashboard itself.)

## Pull in upstream updates (the "sync fork" step)

Do this every so often to stay current with `tiann/hapi`:

```bash
git switch main
git fetch upstream                 # get the latest from tiann/hapi
git merge upstream/main            # merge their changes into yours
# …resolve any conflicts (most likely in files you also edited)…
git push origin main
```

Tips for low‑conflict syncs:
- Your additions live in **new files** (`hub/src/ext/*`, `web/src/routes/dashboard*`,
  `web/src/routes/voice*`, etc.), which never conflict.
- The only files you *modified* in upstream's tree are `hub/src/startHub.ts`,
  `hub/src/web/server.ts`, `web/src/router.tsx`, and `web/src/api/client.ts` —
  all **additive** edits, so conflicts there are small and easy to resolve.

## Before you push — gate checks

```bash
bun run typecheck       # hub + web + cli
bun run --cwd web test  # unit + render tests
bun run build           # full prod build (also re-embeds the web PWA into the hub)
```

## Releasing a deploy

Deploys are **tagged** (like the other k3s apps). Push a **semver** tag and CI
(`.github/workflows/k3s-deploy.yml`) builds + pushes the image to
`ghcr.io/landovsky/hapi-hub`:

```bash
git tag v0.1.0 && git push origin v0.1.0     # must match v*.*.* to trigger the build
```

Then point `~/git/k3s/apps/hapi-hub/deployment.yaml` at `:0.1.0`. Full steps in
[`DEPLOY-k3s.md`](./DEPLOY-k3s.md).
