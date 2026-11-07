#!/usr/bin/env bash
# Deploy Stem to every place that needs the change:
#   vps     stem-server container on the VPS
#   relay   global relay container
#   viewer  public share viewer (static files next to the relay)
#   mac     Mac dmg: build, quit Stem.app, install, start it again
#   ios     iOS app to TestFlight
#
# The script merges the source branch into the deploy worktree, runs the type
# check and the unit tests, and then ships only the targets whose part of the
# tree changed since that target's last deploy.
#
# Hosts, paths and keys come from a local file that is not in git:
#   ${STEM_DEPLOY_ENV:-$HOME/.config/stem/deploy.env}
# See the CONFIG block below for the names.
#
# Usage:
#   scripts/deploy.sh                 # merge 0.8.0, test, ship what changed
#   scripts/deploy.sh --dry-run       # show the plan, change nothing
#   scripts/deploy.sh --only mac,vps  # ship these targets, changed or not
#   scripts/deploy.sh --skip ios      # never ship these targets
#   scripts/deploy.sh --source a --source b   # merge more than one branch
#   scripts/deploy.sh --no-tests --yes
set -euo pipefail
case " $* " in *" -h "*|*" --help "*) sed -n '2,24p' "$0"; exit 0 ;; esac

# ---------------------------------------------------------------- CONFIG
ENV_FILE="${STEM_DEPLOY_ENV:-$HOME/.config/stem/deploy.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi
: "${DEPLOY_WORKTREE:?set DEPLOY_WORKTREE in $ENV_FILE (the worktree that builds the deploy commit)}"
: "${VPS_HOST:?set VPS_HOST in $ENV_FILE (for example user@host)}"
: "${VPS_DIR:=services/stem}"                  # relative to the VPS user's home
: "${RELAY_HOST:?set RELAY_HOST in $ENV_FILE}"
: "${RELAY_DIR:=/root/services/stem-relay}"
: "${RELAY_HEALTH_URL:=}"                      # optional, checked after a relay deploy
: "${DEFAULT_SOURCE:=0.8.0}"
: "${MAC_APP:=/Applications/Stem.app}"
# ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH: optional, passed to ios/scripts/testflight.sh
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/stem-deploy"
LOG_DIR="${DEPLOY_LOG_DIR:-$STATE_DIR/logs/$(date +%Y%m%d-%H%M%S)}"

ALL_TARGETS=(vps relay viewer mac ios)

# Which paths make each target ship. Keep in step with the stem-deploy skill.
paths_for() {
  case "$1" in
    vps)    echo "src/server src/shared scripts/sys-version.mjs Dockerfile package.json package-lock.json docker-compose.yml deploy docs/assistant" ;;
    relay)  echo "relay" ;;
    viewer) echo "src/share src/shared/share.ts vite.share.config.ts" ;;
    # The Mac app runs a local server too, so src/server counts.
    mac)    echo "src/desktop src/renderer src/preload src/shared src/server src/browser-extension electron.vite.config.ts electron-builder.yml package.json package-lock.json native build docs/assistant" ;;
    ios)    echo "ios" ;;
  esac
}

# ---------------------------------------------------------------- ARGS
SOURCES=()
ONLY=""
SKIP=""
DRY=0
TESTS=1
YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCES+=("$2"); shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --dry-run|-n) DRY=1; shift ;;
    --no-tests) TESTS=0; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ ${#SOURCES[@]} -eq 0 ]] && SOURCES=("$DEFAULT_SOURCE")
LAST_SOURCE=${SOURCES[${#SOURCES[@]}-1]}

in_list() { [[ ",$2," == *",$1,"* ]]; }
for t in ${ONLY//,/ } ${SKIP//,/ }; do
  in_list "$t" "$(IFS=,; echo "${ALL_TARGETS[*]}")" || { echo "unknown target: $t" >&2; exit 2; }
done

# ---------------------------------------------------------------- HELPERS
D="$DEPLOY_WORKTREE"
g() { git -C "$D" "$@"; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { printf '\n\033[31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o VisualHostKey=no -o LogLevel=ERROR)
vps() { ssh "${SSH_OPTS[@]}" "$VPS_HOST" "$@"; }
relay() { ssh "${SSH_OPTS[@]}" "$RELAY_HOST" "$@"; }
state_get() { [[ -f "$STATE_DIR/$1" ]] && cat "$STATE_DIR/$1" || true; }
state_set() { mkdir -p "$STATE_DIR"; echo "$2" > "$STATE_DIR/$1"; }
short() { echo "${1:0:8}"; }

res() { printf -v "RESULT_$1" '%s' "$2"; }
resget() { local n="RESULT_$1"; echo "${!n:-?}"; }
base_set() { printf -v "BASE_$1" '%s' "$2"; }
base_get() { local n="BASE_$1"; echo "${!n}"; }
mkdir -p "$LOG_DIR"

# ---------------------------------------------------------------- 1. NOW
say "What runs now"
[[ -d "$D/.git" || -f "$D/.git" ]] || die "no deploy worktree at $D"
V=$(vps "cd $VPS_DIR && git rev-parse HEAD") || die "cannot read the VPS checkout"
VPS_DIRTY=$(vps "cd $VPS_DIR && git status --porcelain --untracked-files=no")
[[ -z "$VPS_DIRTY" ]] || die "the VPS checkout has modified files (an earlier deploy stopped half way):
$VPS_DIRTY"
g cat-file -e "$V^{commit}" 2>/dev/null || die "VPS commit $(short "$V") is not in the local repo"
[[ -z "$(g status --porcelain --untracked-files=no)" ]] || die "the deploy worktree $D has local changes"
PREV=$(g rev-parse HEAD)
note "VPS:             $(short "$V")"
note "deploy worktree: $(short "$PREV")"
for s in "${SOURCES[@]}"; do
  g rev-parse -q --verify "$s^{commit}" >/dev/null || die "no branch or commit '$s'"
  note "source $s:   $(short "$(g rev-parse "$s")")"
done

# Each target ships the diff since its own last deploy. The VPS knows its
# commit; for the others the script keeps a state file. With no state file,
# the deploy worktree's HEAD counts as deployed, because the last deploy
# started from there.
base_set vps "$V"
for t in relay viewer mac ios; do
  b=$(state_get "$t")
  if [[ -n "$b" ]] && g cat-file -e "$b^{commit}" 2>/dev/null; then base_set "$t" "$b"; else base_set "$t" "$PREV"; fi
done

# ---------------------------------------------------------------- 2. MERGE
# In a dry run, plan against the source tips and do not touch the worktree.
if [[ $DRY -eq 1 ]]; then
  HEAD_SHA=$(g rev-parse "$LAST_SOURCE")
  say "Dry run: plan against $LAST_SOURCE ($(short "$HEAD_SHA")), no merge"
else
  say "Merge into the deploy worktree"
  if ! g merge-base --is-ancestor "$V" "$PREV"; then
    note "deploy worktree does not contain the VPS commit; start from $(short "$V")"
    g checkout -q --detach "$V"
  fi
  for s in "${SOURCES[@]}"; do
    if g merge-base --is-ancestor "$s" HEAD; then note "$s: already in"; continue; fi
    if g merge --no-edit -q "$s" >"$LOG_DIR/merge.log" 2>&1; then
      note "$s: merged"; continue
    fi
    # Earlier deploys carry squashed copies of the same work, so most conflicts
    # are duplicates. Take the source side only for files where our side has
    # no line that the source does not also have.
    bad=(_)
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      if ours=$(g show "HEAD:$f" 2>/dev/null) && theirs=$(g show "$s:$f" 2>/dev/null) &&
         [[ -z "$(comm -23 <(sort -u <<<"$ours") <(sort -u <<<"$theirs"))" ]]; then
        g checkout -q --theirs -- "$f" && g add -- "$f"
        note "conflict in $f: our side is a copy, took $s"
      else
        bad+=("$f")
      fi
    done < <(g diff --name-only --diff-filter=U)
    bad=("${bad[@]:1}")
    if [[ ${#bad[@]} -gt 0 ]]; then
      g merge --abort
      die "merge of $s has real conflicts; resolve them by hand in $D:
$(printf '  %s\n' "${bad[@]}")"
    fi
    g commit -q --no-edit
    note "$s: merged after duplicate conflicts"
  done
  HEAD_SHA=$(g rev-parse HEAD)
  if [[ ${#SOURCES[@]} -eq 1 ]] && ! g diff --quiet "${SOURCES[0]}" HEAD; then
    note "WARNING: the deploy commit differs from ${SOURCES[0]}:"
    g diff --stat "${SOURCES[0]}" HEAD | sed 's/^/     /'
  fi
  note "deploy commit: $(short "$HEAD_SHA")"
fi

# ---------------------------------------------------------------- 3. PLAN
say "Plan"
PLAN=(_)  # placeholder: bash 3.2 with set -u fails on an empty array
for t in "${ALL_TARGETS[@]}"; do
  base=$(base_get "$t")
  # shellcheck disable=SC2046
  changed=$(g diff --name-only "$base" "$HEAD_SHA" -- $(paths_for "$t") | wc -l | tr -d ' ')
  if [[ -n "$SKIP" ]] && in_list "$t" "$SKIP"; then
    note "$t: skip (--skip)"; res "$t" "skipped (--skip)"
  elif [[ -n "$ONLY" ]]; then
    if in_list "$t" "$ONLY"; then PLAN+=("$t"); note "$t: SHIP (--only, $changed files changed since $(short "$base"))"
    else note "$t: skip (not in --only)"; res "$t" "skipped (not in --only)"; fi
  elif [[ $changed -gt 0 ]]; then
    PLAN+=("$t"); note "$t: SHIP ($changed files changed since $(short "$base"))"
  else
    note "$t: skip (no change since $(short "$base"))"; res "$t" "skipped (unchanged)"
  fi
done
PLAN=("${PLAN[@]:1}")
has() { [[ ${#PLAN[@]} -gt 0 && " ${PLAN[*]} " == *" $1 "* ]]; }

if [[ $DRY -eq 1 ]]; then echo; echo "Dry run: nothing changed."; exit 0; fi
if [[ ${#PLAN[@]} -eq 0 ]]; then
  echo; echo "Nothing to ship. Deploy commit $(short "$HEAD_SHA") stays in $D."; exit 0
fi

# ---------------------------------------------------------------- 4. CHECK
if [[ -n "$(g diff --name-only "$PREV" HEAD -- package-lock.json)" ]]; then
  say "package-lock.json changed: npm ci in the deploy worktree"
  [[ -L "$D/node_modules" ]] && die "$D/node_modules is a symlink; install there by hand"
  (cd "$D" && npm ci --no-audit --no-fund) >"$LOG_DIR/npm-ci.log" 2>&1 || die "npm ci failed, see $LOG_DIR/npm-ci.log"
fi

if [[ $TESTS -eq 1 ]]; then
  say "Type check and unit tests"
  (cd "$D" && npm run -s typecheck) >"$LOG_DIR/typecheck.log" 2>&1 || die "typecheck failed, see $LOG_DIR/typecheck.log"
  note "typecheck: clean"
  # A busy machine sometimes gives one or two timing failures; run once more.
  if ! (cd "$D" && npx vitest run tests/unit) >"$LOG_DIR/unit.log" 2>&1; then
    note "unit tests failed once; run them again"
    (cd "$D" && npx vitest run tests/unit) >"$LOG_DIR/unit.log" 2>&1 || die "unit tests failed two times, see $LOG_DIR/unit.log"
  fi
  note "unit tests: $(grep -Eo 'Tests +[0-9]+ passed' "$LOG_DIR/unit.log" | tail -1)"
fi

if [[ $YES -eq 0 && -t 0 ]]; then
  echo
  read -r -p "Ship ${PLAN[*]} from $(short "$HEAD_SHA")? [y/N] " ans
  [[ "$ans" == [yY]* ]] || { echo "Stopped. Nothing shipped."; exit 1; }
fi

# ---------------------------------------------------------------- 5. LONG BUILDS
# The dmg and the TestFlight upload take minutes; start them now.
MAC_PID=""; IOS_PID=""
if has mac; then
  say "Start the Mac dmg build (log: $LOG_DIR/dmg.log)"
  (cd "$D" && npm run dist:mac) >"$LOG_DIR/dmg.log" 2>&1 & MAC_PID=$!
fi
if has ios; then
  say "Start the TestFlight upload (log: $LOG_DIR/testflight.log)"
  (cd "$D/ios" && ASC_KEY_ID="${ASC_KEY_ID:-}" ASC_ISSUER_ID="${ASC_ISSUER_ID:-}" ASC_KEY_PATH="${ASC_KEY_PATH:-}" \
    scripts/testflight.sh) >"$LOG_DIR/testflight.log" 2>&1 & IOS_PID=$!
fi

# ---------------------------------------------------------------- 6. VPS
deploy_vps() {
  say "VPS stem-server"
  local bundle="$LOG_DIR/deploy.bundle"
  g bundle create "$bundle" "$V..$HEAD_SHA" >/dev/null 2>&1 || { res vps "FAILED: git bundle"; return 1; }
  scp -q "${SSH_OPTS[@]}" "$bundle" "$VPS_HOST:/tmp/stem-deploy.bundle" || { res vps "FAILED: scp of the bundle"; return 1; }
  local got
  got=$(vps "cd $VPS_DIR && git fetch -q /tmp/stem-deploy.bundle $HEAD_SHA && git merge --ff-only -q $HEAD_SHA && rm -f /tmp/stem-deploy.bundle && git rev-parse HEAD") || got=""
  [[ "$got" == "$HEAD_SHA" ]] || { res vps "FAILED: VPS HEAD is $(short "$got")"; return 1; }
  note "checkout fast-forwarded to $(short "$got")"
  local sha12=${HEAD_SHA:0:12}
  vps "cd $VPS_DIR && STEM_GIT_SHA=$sha12 docker compose build stem" >"$LOG_DIR/vps-build.log" 2>&1 ||
    { res vps "FAILED: docker build, see $LOG_DIR/vps-build.log"; return 1; }
  vps "cd $VPS_DIR && docker compose up -d stem" >>"$LOG_DIR/vps-build.log" 2>&1 ||
    { res vps "FAILED: docker compose up, see $LOG_DIR/vps-build.log"; return 1; }
  local boot=""
  for _ in $(seq 1 18); do
    sleep 5
    boot=$(vps "cd $VPS_DIR && docker compose logs --since 3m stem 2>&1 | grep -E 'system persona.*build' | tail -1" || true)
    [[ "$boot" == *"$sha12"* ]] && break
  done
  local ps
  ps=$(vps "cd $VPS_DIR && docker compose ps stem --format '{{.Status}}'" || true)
  note "boot: ${boot:-<no boot line>}"
  note "container: $ps"
  if [[ "$boot" == *"$sha12"* && "$ps" == Up* && "$ps" != *Restarting* ]]; then
    res vps "shipped, build $sha12"
  else
    res vps "FAILED: no boot line for $sha12 or the container is not Up (check docker logs caddy for heap OOM)"
    return 1
  fi
}

# ---------------------------------------------------------------- 7. RELAY + VIEWER
deploy_relay() {
  say "Global relay"
  relay "grep -Eq 'context: *(\./)?src/?\$' $RELAY_DIR/docker-compose.yml" ||
    { res relay "FAILED: relay compose build context is not ./src; update this script"; return 1; }
  g archive "$HEAD_SHA" relay | relay "cd $RELAY_DIR && rm -rf src.old && mv src src.old && mkdir src && tar -x --strip-components=1 -C src" ||
    { res relay "FAILED: copy of relay/ (old code is in $RELAY_DIR/src.old)"; return 1; }
  relay "cd $RELAY_DIR && docker compose build && docker compose up -d" >"$LOG_DIR/relay.log" 2>&1 ||
    { res relay "FAILED: relay build, see $LOG_DIR/relay.log"; return 1; }
  sleep 5
  relay "docker logs --since 1m stem-relay 2>&1 | tail -5" | sed 's/^/   | /'
  if [[ -n "$RELAY_HEALTH_URL" ]] && ! curl -fsS --max-time 10 "$RELAY_HEALTH_URL" >/dev/null; then
    res relay "FAILED: $RELAY_HEALTH_URL does not answer"; return 1
  fi
  res relay "shipped"
}

deploy_viewer() {
  say "Share viewer"
  (cd "$D" && npm run -s build:share) >"$LOG_DIR/viewer.log" 2>&1 ||
    { res viewer "FAILED: build:share, see $LOG_DIR/viewer.log"; return 1; }
  # Copy into the same directory (rsync --delete), so a bind mount of it
  # still sees the new files. Keep the old files in viewer.old.
  relay "cd $RELAY_DIR && rm -rf viewer.old && cp -a viewer viewer.old" || { res viewer "FAILED: backup of viewer/"; return 1; }
  rsync -a --delete -e "ssh ${SSH_OPTS[*]}" "$D/dist/share/" "$RELAY_HOST:$RELAY_DIR/viewer/" ||
    { res viewer "FAILED: rsync"; return 1; }
  res viewer "shipped"
}

# ---------------------------------------------------------------- 8. MAC
install_mac() {
  say "Mac: install the dmg"
  if ! wait "$MAC_PID"; then res mac "FAILED: dmg build, see $LOG_DIR/dmg.log"; return 1; fi
  local dmg main mnt
  dmg=$(/bin/ls -t "$D"/release/*.dmg | head -1)
  main="$MAC_APP/Contents/MacOS/Stem"
  note "dmg: $(basename "$dmg")"
  mnt=$(hdiutil attach -nobrowse -noautoopen "$dmg" 2>/dev/null | awk -F'\t' '/\/Volumes\//{print $NF}')
  [[ -n "$mnt" ]] || { res mac "FAILED: cannot mount $dmg"; return 1; }
  # Match the main process exactly: Chrome keeps Stem native-host helpers
  # alive, and the iOS Simulator's Stem app has the same name.
  osascript -e 'tell application "Stem" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do pgrep -fxq "$main" || break; sleep 1; done
  if pgrep -fxq "$main"; then
    hdiutil detach -quiet "$mnt" || true
    res mac "NOT INSTALLED: Stem.app did not quit in 60 s (a dialog or a running task?). dmg: $dmg"
    return 1
  fi
  if ! { rm -rf "$MAC_APP" && ditto "$mnt/Stem.app" "$MAC_APP"; }; then
    hdiutil detach -quiet "$mnt" || true
    res mac "FAILED: copy to $MAC_APP"; return 1
  fi
  hdiutil detach -quiet "$mnt" || true
  open -a "$MAC_APP"
  sleep 5
  local ver
  ver=$(defaults read "$MAC_APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?')
  if pgrep -fxq "$main"; then res mac "shipped, Stem $ver installed and running"
  else res mac "installed Stem $ver, but it is not running"; return 1; fi
}

wait_ios() {
  say "TestFlight"
  if wait "$IOS_PID"; then
    grep -E 'EXPORT SUCCEEDED|Upload succeeded' "$LOG_DIR/testflight.log" | tail -2 | sed 's/^/   /'
    res ios "shipped"
  else
    grep -E 'error:' "$LOG_DIR/testflight.log" | tail -5 | sed 's/^/   /'
    res ios "FAILED: see $LOG_DIR/testflight.log"; return 1
  fi
}

# Run each target; one failure does not stop the others. A target records its
# commit only when it shipped.
FAIL=0
run() { local t=$1 fn=$2; if "$fn"; then state_set "$t" "$HEAD_SHA"; else FAIL=1; fi; }
has vps && run vps deploy_vps
has relay && run relay deploy_relay
has viewer && run viewer deploy_viewer
has mac && run mac install_mac
has ios && run ios wait_ios

# ---------------------------------------------------------------- 9. REPORT
say "Result: deploy commit $(short "$HEAD_SHA") (VPS base $(short "$V"))"
for t in "${ALL_TARGETS[@]}"; do printf '   %-7s %s\n' "$t" "$(resget "$t")"; done
note "logs: $LOG_DIR"
exit $FAIL
