# Handoff — deploying the voice-dashboard fork to k3s

Hand-off for taking the `voice-dashboard` work live on the existing `hapi-hub`
k3s deployment (https://hapi.kopernici.cz). Written 2026-06-28.

## Context

- **What's built:** this fork (`~/git/hapi-happy`, branch `voice-dashboard`, 6 commits
  off `main`) adds a mobile-first voice dashboard onto HAPI — `/dashboard` (dense
  triage board) + `/voice/:id` (tap-to-talk), plus an additive hub backend
  (ext store: pins + read-state; routes: tts/stt/summarize/suggest-replies).
  Merge-clean: a separate `hapi-ext.db`, zero upstream-schema edits.
- **State:** full fork typecheck (hub + web) + 20 tests + prod build all green.
  **Nothing is deployed** — the live hub still runs upstream.
- **Core blocker:** the live hub installs the *published npm package*
  (`@twsxtd/hapi`) at container start. The fork is **not published**, so going
  live means shipping our own artifact (image or binary) instead of npm-global.
- **GitOps:** the cluster is **Flux**. `~/git/k3s/clusters/production/apps/hapi-hub.yaml`
  is a Flux Kustomization that reconciles `./apps/hapi-hub` every 5 min
  (`prune: true`, `wait: true`). So a manifest change pushed to the k3s repo
  auto-applies — no manual `kubectl apply` needed.

## Current k3s state (`~/git/k3s/apps/hapi-hub/`)

- `deployment.yaml` — `image: node:22-slim`; container command does
  `npm install -g @twsxtd/hapi @twsxtd/hapi-linux-<arch> && exec hapi hub`.
  Port 3006; `HAPI_LISTEN_HOST=0.0.0.0`; `envFrom: hapi-hub-secrets`;
  `/health` liveness+readiness; `strategy: Recreate` (SQLite single-writer).
- `secret.yaml` — placeholder only (real `hapi-hub-secrets` is created
  out-of-band on the cluster); today holds `CLI_API_TOKEN` + `ELEVENLABS_API_KEY`.
- `service.yaml` — ClusterIP 80 → 3006.
- `ingress.yaml` — Traefik, host `hapi.kopernici.cz`, TLS via cert-manager,
  **SSE response buffering disabled** (good — the dashboard/voice use SSE).
- `pvc.yaml` — 1Gi RWO at `/root/.hapi` (sessions + now also `hapi-ext.db`).

## Build & release (reproducible — tagged deploys)

The image build now lives in the repo, mirroring the other k3s apps
(`landovsky/pharmacy`): **push a semver tag and CI builds + pushes to GHCR.**

- **`Dockerfile`** — two-stage Bun build: installs, runs `bun run build` (web →
  `generate:embedded-web-assets` → hub), then a slim runtime that runs the hub
  **from source**: `bun run hub/src/index.ts` (entry → `startHub()`, listens on
  3006). `bun:sqlite` means no native modules. Data dir pinned to
  `HAPI_HOME=/root/.hapi` to match the PVC mount. *Validated locally: builds,
  boots, `/health` → 200.*
- **`.github/workflows/k3s-deploy.yml`** — on `push: tags: ['v*.*.*']` (+
  manual `workflow_dispatch`), builds and pushes `ghcr.io/landovsky/hapi-hub`
  tagged `{{version}}`, `{{major}}.{{minor}}`, `{{major}}`, and `sha-…`.

### Cut a release

```bash
git tag v0.1.0 && git push origin v0.1.0      # → CI builds ghcr.io/landovsky/hapi-hub:0.1.0
```

Then point the cluster at that tag (k3s repo, Flux applies within 5 min):

- [ ] In `~/git/k3s/apps/hapi-hub/deployment.yaml`, set
      `image: ghcr.io/landovsky/hapi-hub:0.1.0` (currently pinned to the mutable
      `:voice-dashboard` tag). Keep `imagePullPolicy`, `env`, `envFrom`, `ports`,
      `volumeMounts`, probes as-is — the image provides its own `CMD`, so there
      must be **no `command:` override**.
- [ ] Commit + push the k3s repo → Flux rolls it out. (Force now with
      `kubectl rollout restart deploy/hapi-hub -n default` — `imagePullPolicy` is
      already `Always`.)
- [ ] **`GEMINI_API_KEY`** in `hapi-hub-secrets` (for `/summarize` +
      `/suggest-replies`; the rest works without it):
  ```bash
  kubectl -n default patch secret hapi-hub-secrets --type=merge \
    -p '{"stringData":{"GEMINI_API_KEY":"…","ELEVENLABS_API_KEY":"…"}}'
  ```

### Local build (no CI / no registry)

```bash
docker build -t ghcr.io/landovsky/hapi-hub:dev .
docker save ghcr.io/landovsky/hapi-hub:dev | sudo k3s ctr images import -   # single-node
```

## Things to verify

- **STT body size.** `/stt` reads the raw audio body (~30–60s clips). Verify Traefik
  doesn't cap request body for that route; raise the limit if uploads 413.
- **PVC carries `hapi-ext.db`.** It's created next to `hapi.db` on first run on the
  existing 1Gi volume — fine, just be aware it now lives on that PVC.
- **`Recreate` strategy + first-run npm removal.** Image start is much faster than
  the old npm-install path; the Recreate gap should shrink. No data migration —
  upstream tables untouched.
- **Branch → main.** Decide whether to merge `voice-dashboard` → `main` before
  building, or build straight from the branch. Nothing forces a merge first.

## Verify after rollout

- [ ] `kubectl -n default rollout status deploy/hapi-hub` healthy; `/health` 200.
- [ ] Load https://hapi.kopernici.cz → `/dashboard` renders the dense board with live
      sessions; tiles show status chips + elapsed; waiting pill appears when one blocks.
- [ ] `/voice/:id` reads a reply aloud (TTS) and a recorded clip sends (STT) — proves
      the ElevenLabs path; summarize/suggest answer once `GEMINI_API_KEY` is set.
- [ ] Handover: a session opened from the board continues fine in the regular HAPI view.

## Rollback

- Revert `deployment.yaml` to `image: node:22-slim` + the npm-install command and
  push (Flux re-applies), or `kubectl rollout undo deploy/hapi-hub -n default`.
  Data is safe — the ext layer never touched upstream tables.
