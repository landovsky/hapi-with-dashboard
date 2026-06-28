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

## What must change

- [ ] **Ship the fork as an image** (not npm-global) and point the deployment at it.
- [ ] **Rebuild + embed the web PWA** so the hub serves the *new* dashboard —
      `bun run build` runs `web` build → `generate:embedded-web-assets` → hub build.
      (Skipping the embed step ships the new server with the *old* UI.)
- [ ] **Add `GEMINI_API_KEY`** to `hapi-hub-secrets` — `/summarize` + `/suggest-replies`
      fail soft with HTTP 400 until it's present (rest of the board works without it).
- [ ] Confirm the **hub entrypoint** for the fork (see "Open decisions").

## Recommended path — local image, import into k3s (single-node, no registry)

Leanest for this homelab; avoids standing up/authing a registry.

- [ ] Add a `Dockerfile` to the fork: `FROM oven/bun:1`; copy repo; `bun install`;
      `bun run build`; entrypoint that boots the hub on :3006 (see Open decisions).
- [ ] Build + import into k3s's containerd:
  ```bash
  docker build -t hapi-hub-fork:voice-dashboard .
  docker save hapi-hub-fork:voice-dashboard | sudo k3s ctr images import -
  ```
- [ ] Edit `~/git/k3s/apps/hapi-hub/deployment.yaml`:
  - `image: docker.io/library/hapi-hub-fork:voice-dashboard`
  - `imagePullPolicy: Never` (image lives only in local containerd)
  - **remove** the `npm install … && exec hapi hub` command block — let the image's
    entrypoint run; keep `env`, `envFrom`, `ports`, `volumeMounts`, probes as-is.
- [ ] Add the Gemini key to the secret (envFrom picks it up automatically):
  ```bash
  kubectl -n default create secret generic hapi-hub-secrets \
    --from-literal=CLI_API_TOKEN="…" \
    --from-literal=ELEVENLABS_API_KEY="…" \
    --from-literal=GEMINI_API_KEY="…" \
    --dry-run=client -o yaml | kubectl apply -f -
  ```
- [ ] Commit the deployment.yaml change to the **k3s repo** → Flux applies within 5 min
      (or `kubectl rollout restart deploy/hapi-hub -n default` to force now).

### Alternative — GHCR image (if multi-node or you want pure GitOps)
- [ ] Build + push `ghcr.io/<user>/hapi-hub:voice-dashboard`; add an `imagePullSecret`
      if the package is private; set `imagePullPolicy: IfNotPresent`.
- [ ] Same deployment.yaml + secret edits. Cleaner for reproducible GitOps, but
      needs registry auth on the cluster.

## Open decisions / things to verify

- **Hub entrypoint in the image.** Upstream runs the CLI subcommand `hapi hub`.
  For the fork, confirm which boots the hub server on :3006 with a working `/health`:
  (a) `bun run build:single-exe` → run the produced `hapi` binary `hapi hub`
  (mirrors upstream exactly), or (b) run the built hub bundle directly via `bun`.
  Recommend (a) — least surprise, same command the manifest already used.
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
