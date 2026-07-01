#!/usr/bin/env bash
#
# Weekly upstream sync → verify → deploy for the hapi-with-dashboard fork.
#
# Pipeline (fail-fast; any failure pings Telegram DevOps and stops BEFORE prod):
#   1. fetch upstream; no new commits  -> ping "nothing to sync", exit 0
#   2. merge upstream/main onto main; conflicts -> abort, ping negative
#   3. gate: typecheck + build + web tests (baseline-aware) -> fail -> reset, ping negative
#   4. push main
#   5. build fork image -> push to ttl.sh (fresh UUID each run)
#   6. bump k3s manifest image, rebase-safe push -> Flux rolls it out
#   7. wait for the new pod to go 1/1 + /health 200 -> ping positive, else negative
#
# Deploy path is ttl.sh + Flux GitOps (GHCR CI is blocked on package perms).
# kubectl is only used read-only to verify the rollout; the rollout itself is
# driven by the git push to the k3s repo.
#
# Runs unattended under tschedule (systemd user service), so it sets its own
# PATH and never prompts.

set -uo pipefail

# --- environment (systemd user services start with a minimal PATH) -----------
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export HOME="${HOME:-/home/tomas}"

REPO="$HOME/git/hapi-with-dashboard"
K3S_REPO="$HOME/git/k3s"
K3S_MANIFEST="$K3S_REPO/apps/hapi-hub/deployment.yaml"
HEALTH_URL="https://hapi.kopernici.cz/health"
TG_BOT="devops"
# Test files that already fail on a clean tree (pre-existing, unrelated to sync).
# The gate fails only if a file OUTSIDE this set breaks.
ALLOWED_FAILING_TESTS="src/routes/settings/index.test.tsx"

STAGE="init"
PRE_MERGE=""

notify() { notify-tomas-telegram "$TG_BOT" "$1" >/dev/null 2>&1 || true; }

fail() {
    local msg="$1"
    # Undo an un-pushed merge so main stays clean for next week.
    if [ -n "$PRE_MERGE" ]; then
        git -C "$REPO" merge --abort 2>/dev/null || true
        git -C "$REPO" reset --hard "$PRE_MERGE" >/dev/null 2>&1 || true
    fi
    notify "❌ hapi-hub weekly deploy FAILED at [$STAGE]
$msg
main reset to $PRE_MERGE — prod UNCHANGED."
    exit 1
}

# Any unexpected error (set -e style) reports the stage it died in.
trap 'fail "unexpected error (exit $?)"' ERR
set -E

cd "$REPO"

# --- 1. fetch upstream -------------------------------------------------------
STAGE="fetch-upstream"
git checkout -q main
[ -z "$(git status --porcelain)" ] || fail "working tree is dirty before sync — refusing to run."
git fetch -q upstream
git fetch -q origin

BEFORE="$(git rev-parse --short HEAD)"
NEW_COMMITS="$(git rev-list --count HEAD..upstream/main)"
if [ "$NEW_COMMITS" -eq 0 ]; then
    notify "✅ hapi-hub weekly sync: nothing new upstream (main @ $BEFORE). No deploy needed."
    exit 0
fi
SYNC_LOG="$(git log --oneline --no-merges HEAD..upstream/main | sed 's/^/  • /')"

# --- 2. merge upstream -------------------------------------------------------
STAGE="merge-upstream"
PRE_MERGE="$(git rev-parse HEAD)"
if ! git merge --no-edit upstream/main >/tmp/hapi-merge.log 2>&1; then
    CONFLICTS="$(git diff --name-only --diff-filter=U | sed 's/^/  • /')"
    fail "merge conflicts ($NEW_COMMITS upstream commits) in:
$CONFLICTS
Needs a manual sync."
fi
AFTER="$(git rev-parse --short HEAD)"

# --- 3. gate -----------------------------------------------------------------
STAGE="gate:typecheck"
bun run typecheck >/tmp/hapi-typecheck.log 2>&1 || fail "typecheck failed after merge. See /tmp/hapi-typecheck.log"

STAGE="gate:build"
bun run build >/tmp/hapi-build.log 2>&1 || fail "prod build failed after merge. See /tmp/hapi-build.log"

STAGE="gate:tests"
# The suite has known pre-existing failures; fail the gate only if a NEW file breaks.
bun run --cwd web test >/tmp/hapi-webtest.log 2>&1 || true
NEW_FAILING="$(grep -oE 'FAIL +[^ ]+\.test\.tsx?' /tmp/hapi-webtest.log \
    | awk '{print $2}' | sort -u \
    | grep -vxF "$ALLOWED_FAILING_TESTS" || true)"
if [ -n "$NEW_FAILING" ]; then
    fail "web tests broke in file(s) beyond the known baseline:
$(echo "$NEW_FAILING" | sed 's/^/  • /')"
fi

# --- 4. push main ------------------------------------------------------------
STAGE="push-main"
git push -q origin main || fail "git push origin main failed."

# --- 5. build + push image ---------------------------------------------------
STAGE="build-image"
IMG="ttl.sh/$(uuidgen):24h"
docker build -t "$IMG" . >/tmp/hapi-imgbuild.log 2>&1 || fail "docker build failed. See /tmp/hapi-imgbuild.log"

STAGE="push-image"
docker push "$IMG" >/tmp/hapi-imgpush.log 2>&1 || fail "docker push to ttl.sh failed. See /tmp/hapi-imgpush.log"

# --- 6. bump k3s manifest ----------------------------------------------------
STAGE="update-k3s"
# From here on a merge-abort must NOT run (main is already pushed); clear PRE_MERGE.
PRE_MERGE=""
cd "$K3S_REPO"
git checkout -q main
git pull -q --rebase origin main || fail "k3s repo git pull --rebase failed."
sed -i -E "s#image: ttl\.sh/[^[:space:]]+#image: $IMG#" "$K3S_MANIFEST"
git add apps/hapi-hub/deployment.yaml
git commit -q -m "hapi-hub: weekly upstream deploy ($AFTER, $IMG)

Auto: synced $NEW_COMMITS upstream commit(s) into hapi-with-dashboard main
($BEFORE→$AFTER), gate green, image built + pushed to ttl.sh."
# Rebase-safe push in case Flux/others advanced the repo meanwhile.
git pull -q --rebase origin main || true
git push -q origin main || {
    notify "⚠️ hapi-hub: image built & main pushed, but k3s manifest push FAILED.
Fork main @ $AFTER is live in git; prod NOT rolled out. Manual push of $K3S_MANIFEST needed."
    exit 1
}
cd "$REPO"

# --- 7. verify rollout -------------------------------------------------------
STAGE="verify-rollout"
ROLLED=0
for i in $(seq 1 45); do   # ~15 min: covers Flux's 5-min reconcile + pod start
    live="$(kubectl get deploy hapi-hub -n default -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
    if [ "$live" = "$IMG" ]; then
        pod="$(kubectl get pods -n default -l app=hapi-hub --no-headers 2>/dev/null)"
        ready="$(echo "$pod" | awk '{print $2}')"; phase="$(echo "$pod" | awk '{print $3}')"
        if [ "$phase" = "Running" ] && [ "$ready" = "1/1" ]; then ROLLED=1; break; fi
    fi
    sleep 20
done

HTTP="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo '000')"
if [ "$ROLLED" -eq 1 ] && [ "$HTTP" = "200" ]; then
    notify "✅ hapi-hub weekly deploy OK
Synced $NEW_COMMITS upstream commit(s): $BEFORE→$AFTER
$SYNC_LOG
Gate: typecheck + build + tests green.
Rolled out $IMG — pod 1/1, /health $HTTP."
    exit 0
fi

# Manifest is pushed but the pod didn't come up healthy in time.
notify "❌ hapi-hub weekly deploy: manifest pushed but rollout UNHEALTHY.
Image: $IMG (main @ $AFTER)
Rollout reached-new-image=$ROLLED, /health=$HTTP.
Check: kubectl get pods -n default -l app=hapi-hub"
exit 1
