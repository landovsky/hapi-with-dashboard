# CLAUDE.md

Guidance for Claude Code / AI agents working in this repo.

This is **`hapi-with-dashboard`** — a maintained fork of
[`tiann/hapi`](https://github.com/tiann/hapi) that adds a mobile-first **voice
dashboard** (`web/src/routes/dashboard*`, `web/src/routes/voice*`) on top of an
additive hub backend (`hub/src/ext/*`, `hub/src/web/routes/{pins,readState,tts,stt,summarize,suggestReplies}`).

## Start here

- **[AGENTS.md](./AGENTS.md)** — architecture, repo layout, conventions (the primary upstream guide; read it first).
- **[FORK.md](./FORK.md)** — how this fork is managed: remotes, syncing `upstream`, topic-branch flow.
- **[docs/devops.md](./docs/devops.md)** — **DevOps & debugging workflow** for the deployed `hapi-hub` (k3s logs, pod debugging, SQLite access, the bug → issue → test → fix → deploy loop).
- **[DEPLOY-k3s.md](./DEPLOY-k3s.md)** — taking changes live on k3s (`hapi.kopernici.cz`).

## Non-negotiables

- **Merge-clean rule:** keep changes in our additive files; touch upstream files
  only with small additive edits. Our pins/read-state live in a separate
  `hapi-ext.db`, never in upstream's schema. This keeps `git merge upstream/main` cheap.
- **Gate before pushing:** `bun run typecheck && bun run --cwd web test && bun run build`.
- **Track bugs as GitHub issues** on `landovsky/hapi-with-dashboard` — see [docs/devops.md](./docs/devops.md).
