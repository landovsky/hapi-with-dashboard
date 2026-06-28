# DevOps & Debugging Workflow — hapi-hub

A systematic approach to debugging and operating the deployed **hapi-hub** fork
(this repo's voice-dashboard derivative of `tiann/hapi`) on k3s.

Adapted from the pharmacy production-debugging workflow, re-grounded in this
stack: **Bun + Hono + SQLite hub**, **React/Vite PWA**, deployed to **k3s**
(`hapi.kopernici.cz`). There is no Rails, no Postgres, and (today) no BugSink /
Grafana — see [Observability gaps](#observability-gaps).

## Core Principles

1. **Track bugs with GitHub issues** on `landovsky/hapi-with-dashboard` — not
   TaskCreate / TodoWrite / scratch markdown.
2. **Open the issue _before_ writing code** — establish tracking first.
3. **Link evidence in the issue** — the failing log line, pod event, or browser
   network response. Maintain traceability.
4. **Commit with context** — root cause + fix + `Fixes #NN`.
5. **Test before closing** — a regression test that fails before, passes after.
6. **Respect the merge-clean rule** — fixes go in our additive files where
   possible (`hub/src/ext/*`, `web/src/routes/dashboard*|voice*`, …); touch
   upstream files only with small additive edits (see [FORK.md](../FORK.md)).

---

## Tools

### Deployment shape (know this first)

| Thing | Value |
|---|---|
| Namespace | `default` |
| Deployment / label | `hapi-hub` / `app=hapi-hub` |
| Container | `hapi-hub` (Bun) · port `3006` |
| Data | SQLite on PVC `hapi-hub-data` at `/root/.hapi/` — `hapi.db` (upstream) + `hapi-ext.db` (our pins/read-state) |
| Strategy | `Recreate` (SQLite is single-writer) |
| Secrets | `hapi-hub-secrets` (`CLI_API_TOKEN`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`) via `envFrom` |
| Ingress | Traefik → `hapi.kopernici.cz`, TLS via cert-manager, SSE buffering off |
| GitOps | Flux reconciles `~/git/k3s/apps/hapi-hub` every 5 min |

### k3s logs (primary signal)

```bash
# Tail recent hub logs
kubectl logs -n default -l app=hapi-hub --tail=200

# Follow live
kubectl logs -n default -l app=hapi-hub -f

# Errors in the last hour
kubectl logs -n default -l app=hapi-hub --since=1h | grep -iE 'error|warn|throw|unhandled'

# After a crash — the previous container's logs
kubectl logs -n default -l app=hapi-hub --previous
```

### k3s pod debugging

```bash
# Pod status / restarts
kubectl get pods -n default -l app=hapi-hub

# Events: OOMKilled, CrashLoopBackOff, scheduling, probe failures
kubectl describe pod -n default -l app=hapi-hub

# Shell into the hub container
kubectl exec -it -n default deploy/hapi-hub -c hapi-hub -- sh

# Liveness/readiness target
kubectl exec -n default deploy/hapi-hub -c hapi-hub -- wget -qO- localhost:3006/health
```

### SQLite data access (read-only)

The hub is the single writer — **always open read-only** so you never lock or
corrupt the live DB (WAL makes concurrent reads safe):

```bash
kubectl exec -it -n default deploy/hapi-hub -c hapi-hub -- \
  sqlite3 -readonly /root/.hapi/hapi.db

# Our additive store (pins + read-state), separate file:
kubectl exec -it -n default deploy/hapi-hub -c hapi-hub -- \
  sqlite3 -readonly /root/.hapi/hapi-ext.db ".tables"
```

If `sqlite3` isn't in the image, `.dump` a copy out instead:
`kubectl exec … -- cat /root/.hapi/hapi-ext.db > /tmp/ext.db` then inspect locally.

### GitHub issues

```bash
gh issue create -R landovsky/hapi-with-dashboard -t "<title>" -b "<context + evidence>"
gh issue list   -R landovsky/hapi-with-dashboard
```

> `gh` auth in some shells is currently broken (invalid `GITHUB_TOKEN`). Fix with
> `gh auth login` or a `repo`-scoped PAT before using `gh` API/issue commands.

### Frontend (PWA) debugging

Most dashboard/voice issues are client-side — debug in the browser, not the pod:

- **Network tab** → watch `/api/*` calls. `401` = JWT/auth (`POST /api/auth`);
  `400` from `/summarize`/`/suggest-replies` = missing `GEMINI_API_KEY`;
  `502` from `/tts`/`/stt` = ElevenLabs/provider error.
- **Console** → React errors, SSE disconnects.
- **Application → Service Workers** → stale PWA cache; "Update on reload" or
  unregister when a deploy doesn't show up.
- Reproduce locally against a dev hub: `bun run dev` (hub + web together).

### Observability gaps

No error tracker (Sentry/BugSink) or log shipping (Grafana/Loki) is wired for
this deployment yet. **`kubectl logs` + browser devtools are the primary
signals.** If recurring production errors need triage, add Sentry to the hub and
revisit this section — leave a TODO issue rather than debugging blind.

---

## Systematic Debugging Process

Use common sense; override the order when justified.

1. **Reproduce** — confirm the symptom (URL, action, session).
2. **Locate the layer** — client (browser console/network) vs hub (`kubectl logs`).
3. **Gather evidence** — the failing log line / stacktrace / network response.
4. **Inspect state if needed** — read-only SQLite, pod events (`describe`).
5. **Identify root cause.**
6. **Open a GitHub issue** with the evidence.

**Stop and report if:**
- you don't have high confidence in the root cause, or
- the bug points at an architectural problem (especially anything that would
  force a non-additive change to an upstream file — that breaks merge-cleanliness).

## Implementing the Fix

1. Run the gates first (assume something may already be red):
   ```bash
   bun run typecheck          # hub + web + cli
   bun run --cwd web test     # unit + render tests
   ```
2. Write a test that **reproduces** the bug (vitest — colocated `*.test.ts(x)`).
   Name it for the *why*, e.g. the real-world condition it guards.
3. Implement the fix (prefer our additive files; small additive edits upstream).
4. Re-run the test — it should now pass. If not, revisit the hypothesis.
5. Full gate before pushing — and watch for regressions:
   ```bash
   bun run typecheck && bun run --cwd web test && bun run build
   ```
   `bun run build` also re-embeds the web PWA into the hub, so it's the real
   "would this deploy" check.

## Finalizing

- **Commit with context** — root cause + fix, `Fixes #NN`, keep the HAPI +
  Claude co-author footers (see existing history).
- **Close the issue and push** — unless you have reservations about the root
  cause or the fix approach, in which case report instead.
- **Deploying the fix** is a separate step — a code merge does **not** update the
  cluster by itself. Rebuild the image and roll out per [DEPLOY-k3s.md](../DEPLOY-k3s.md).
  Tag what you ship (`git tag -a vX.Y.Z -m …`) so you can roll back.
