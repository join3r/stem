#!/usr/bin/env bash
# Keep a Stem server on the newest commit of the branch it was cloned from.
#
#   deploy/auto-update.sh                    update now, if there is anything new
#   sudo deploy/auto-update.sh --install     check every night at about 04:00
#   sudo deploy/auto-update.sh --uninstall   stop checking
#
# One run is the "Upgrading" section of docs/running-on-a-server.md with the
# checks a person would make by eye: nothing new, nothing happens; something
# new, take a backup, pull, build, restart, and wait for the server to say it is
# listening. A build that fails leaves the running containers alone. A server
# that does not come up is put back on the images it ran before, and that
# commit is skipped on later nights until the branch moves past it, so a broken
# commit costs one restart, not one every night.
#
# Settings, all optional, from the environment or from .env beside
# docker-compose.yml:
#   STEM_BACKUP_DIR      where the archives go (default: backups/ in the checkout)
#   STEM_KEEP_BACKUPS    how many of this script's archives to keep (default: 7)
#   STEM_UPDATE_TIMEOUT  seconds to wait for the new server to listen (default: 180)
#
# Everything is wrapped in main(), and main is called on the last line: bash
# has then read the whole file before running any of it, so the `git pull`
# below can rewrite this script without confusing the copy that is running.

set -euo pipefail

STEM_DIR="${STEM_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
UNIT=stem-auto-update
FAILED_MARK=.auto-update-failed

log() { printf '[auto-update] %s\n' "$*"; }
die() { log "$*"; exit 1; }

# A value from the environment, else from .env, else the default.
setting() {
  local name=$1 default=$2 value
  value="${!name:-}"
  if [ -z "$value" ] && [ -f "$STEM_DIR/.env" ]; then
    value="$(sed -n "s/^${name}=//p" "$STEM_DIR/.env" | tail -n1 | tr -d '"'"'"'')"
  fi
  printf '%s' "${value:-$default}"
}

install_timer() {
  [ "$(id -u)" -eq 0 ] || die "--install writes to /etc/systemd/system: run it with sudo"
  command -v systemctl >/dev/null || die "no systemd on this machine; run deploy/auto-update.sh from cron instead"
  # The service runs as whoever owns the checkout: that user can already run
  # docker and git here, and root is not needed for either.
  local owner
  owner="$(stat -c %U "$STEM_DIR")"
  [ "$owner" != root ] || log "note: $STEM_DIR is owned by root, so updates will run as root"
  cat >/etc/systemd/system/$UNIT.service <<EOF
[Unit]
Description=Update Stem to the newest commit
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=$owner
WorkingDirectory=$STEM_DIR
ExecStart=$STEM_DIR/deploy/auto-update.sh
EOF
  cat >/etc/systemd/system/$UNIT.timer <<EOF
[Unit]
Description=Update Stem every night

[Timer]
OnCalendar=*-*-* 04:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now $UNIT.timer
  log "installed: $STEM_DIR is updated every night as $owner"
  log "next run:  systemctl list-timers $UNIT.timer"
  log "run now:   sudo systemctl start $UNIT.service"
  log "history:   journalctl -u $UNIT.service"
}

uninstall_timer() {
  [ "$(id -u)" -eq 0 ] || die "--uninstall writes to /etc/systemd/system: run it with sudo"
  systemctl disable --now $UNIT.timer 2>/dev/null || true
  rm -f /etc/systemd/system/$UNIT.service /etc/systemd/system/$UNIT.timer
  systemctl daemon-reload
  log "removed: Stem is no longer updated automatically"
}

# Wait for the stem container to say it is listening since it last started,
# and for both services to still be running a moment later. Reading from the
# container's own start time, not from when `up` ran, matters: a commit that
# does not change the image (docs, release notes) leaves the container as it
# was, and it said "listening" long ago.
wait_until_up() {
  local timeout=$1 waited=0 cid since running
  while [ "$waited" -lt "$timeout" ]; do
    cid="$(docker compose ps -q stem)"
    if [ -n "$cid" ]; then
      since="$(docker inspect -f '{{.State.StartedAt}}' "$cid")"
      if docker logs --since "$since" "$cid" 2>&1 | grep -q 'listening on'; then
        sleep 5
        running="$(docker compose ps --status running --services)"
        grep -qx stem <<<"$running" && grep -qx caddy <<<"$running" &&
          [ "$(docker inspect -f '{{.State.StartedAt}}' "$cid")" = "$since" ] && return 0
      fi
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

prune_backups() {
  local dir=$1 keep=$2
  # Only this script's own archives, newest first; anything else in the
  # directory is somebody's and is left alone.
  find "$dir" -maxdepth 1 -name 'auto-update-*.tar' -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | tail -n +"$((keep + 1))" | cut -d' ' -f2- |
    while read -r old; do rm -f -- "$old" && log "removed old backup $(basename "$old")"; done
}

update() {
  cd "$STEM_DIR"
  [ -d .git ] || die "$STEM_DIR is not a git checkout"

  # One update at a time: a manual run and the timer must not race.
  exec 9>"$STEM_DIR/.auto-update.lock"
  flock -n 9 || die "another update is already running"

  local upstream
  upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" ||
    die "the checkout is not on a branch that tracks a remote (detached HEAD?)"
  git fetch --quiet || die "could not fetch from $(git remote get-url "${upstream%%/*}")"

  local old new
  old="$(git rev-parse HEAD)"
  new="$(git rev-parse "$upstream")"
  if [ "$old" = "$new" ]; then
    log "up to date at $(git log -1 --format='%h %s')"
    return 0
  fi
  if ! git merge-base --is-ancestor "$old" "$new"; then
    die "$STEM_DIR has commits that are not on $upstream; not touching it"
  fi
  if [ -f "$FAILED_MARK" ] && [ "$(cat "$FAILED_MARK")" = "$new" ]; then
    log "skipping $(git log -1 --format='%h %s' "$new"): it did not come up last time; waiting for a newer commit"
    return 0
  fi
  log "updating $(git rev-parse --short "$old") -> $(git log -1 --format='%h %s' "$new") ($(git rev-list --count "$old..$new") commits)"

  local backup_dir keep timeout
  backup_dir="$(setting STEM_BACKUP_DIR "$STEM_DIR/backups")"
  keep="$(setting STEM_KEEP_BACKUPS 7)"
  timeout="$(setting STEM_UPDATE_TIMEOUT 180)"
  case "$backup_dir" in /*) ;; *) backup_dir="$STEM_DIR/$backup_dir" ;; esac
  mkdir -p "$backup_dir"

  local archive
  archive="auto-update-$(date +%Y-%m-%d-%H%M%S)-$(git rev-parse --short "$old").tar"
  log "backing up to $backup_dir/$archive"
  docker compose run --rm -v "$backup_dir:/backup" \
    stem node dist/main/server.js export "/backup/$archive" >/dev/null ||
    die "backup failed; nothing was changed"

  # Keep the images that are running now under a second tag, so going back is a
  # retag and a restart rather than a rebuild of the old commit.
  local images img
  images="$(docker compose config --images)"
  for img in $images; do docker tag "$img" "${img%:*}:before-update"; done

  git merge --ff-only --quiet "$new"
  export STEM_GIT_SHA
  STEM_GIT_SHA="$(git rev-parse --short=12 HEAD)"

  if ! docker compose build; then
    log "build failed; the server is still running $(git rev-parse --short "$old")"
    git reset --quiet --keep "$old"
    echo "$new" >"$FAILED_MARK"
    exit 1
  fi

  docker compose up -d
  if wait_until_up "$timeout"; then
    rm -f "$FAILED_MARK"
    log "running $(git log -1 --format='%h %s')"
    docker image prune -f >/dev/null
    prune_backups "$backup_dir" "$keep"
    return 0
  fi

  log "the new server did not come up within ${timeout}s; its last lines:"
  docker compose logs --tail=30 stem || true
  log "going back to $(git rev-parse --short "$old")"
  for img in $images; do docker tag "${img%:*}:before-update" "$img"; done
  git reset --quiet --keep "$old"
  echo "$new" >"$FAILED_MARK"
  STEM_GIT_SHA="$(git rev-parse --short=12 HEAD)"
  docker compose up -d
  # The old images came up before, so a slow start here is just slow; give it
  # at least the default.
  if wait_until_up "$((timeout > 180 ? timeout : 180))"; then
    log "back on $(git rev-parse --short HEAD); the backup from before the attempt is $backup_dir/$archive"
  else
    log "the previous version did not come up either; see docs/running-on-a-server.md, 'When it does not come up'"
    log "the backup from before the attempt is $backup_dir/$archive"
  fi
  exit 1
}

main() {
  case "${1:-}" in
    --install) install_timer ;;
    --uninstall) uninstall_timer ;;
    "") update ;;
    *) die "usage: $0 [--install | --uninstall]" ;;
  esac
}

main "$@"; exit
