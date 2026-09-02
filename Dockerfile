# Stem, headless, in a container.
#
# What runs in here is `dist/main/server.js` under plain `node` — the same entry
# scripts/server-boot.mjs has been booting since Phase 1, on the machine it was
# always meant for. There is no Electron in this image and no way for one to get
# in: the production stage installs `--omit=dev`, and electron is a devDependency.
#
# THE ONE RULE FOR node_modules: it is built HERE, never copied from a laptop.
# @huggingface/transformers pulls onnxruntime-node, which ships a compiled .node
# binary per platform+arch — a macOS arm64 build copied into a Linux image loads
# as far as `dlopen` and then dies at the first embedding. `npm ci` inside the
# image resolves the right one because it is running on the right machine.
#
# ARCH. The target is linux/amd64 unless told otherwise, because that is what a
# VPS is unless it says so — Hetzner/DO/Vultr's default plans are all x86_64, and
# an image built on an Apple Silicon Mac would otherwise be arm64 and simply not
# start there. Override it for an arm VPS (Hetzner CAX, Oracle Ampere, a Pi):
#
#   docker compose build --build-arg NODE_IMAGE=node:24-bookworm-slim   # unchanged
#   STEM_PLATFORM=linux/arm64 docker compose build
#
# Building for a platform you are not on goes through QEMU and is slow but works;
# building ON the server is faster and is what the runbook recommends.
#
# Debian slim rather than Alpine, deliberately: onnxruntime-node's prebuilt
# binaries are linked against glibc, and musl has no ABI-compatible answer. The
# saving would be ~50 MB against a base that is already carrying model runtimes.

ARG NODE_IMAGE=node:24-bookworm-slim
# uv/uvx, the way half the MCP world is launched — see the runtime stage. Pinned
# and overridable (`docker compose build --build-arg UV_IMAGE=…`); the binaries
# are static musl builds, so the tag's own base does not matter here.
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.5

# ---- stage 1: the bundle -----------------------------------------------------
#
# electron-vite emits dist/main (the server and its workers), dist/preload and
# dist/renderer. Only the first is reachable from here, but the build is one
# command and splitting it would mean maintaining a second config that could
# drift from the one the desktop is built with.
#
# The two SKIPs are the difference between a two-minute stage and a fifteen-minute
# one. `npm ci` here installs devDependencies because the bundler is one, and two
# of them fetch browsers on install: electron's ~120 MB Chromium and Playwright's
# three engines. The bundler needs electron's *module* to resolve, not its binary,
# and nothing in this image ever runs a test.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# patches/ and scripts/ensure-electron.mjs are named by `postinstall`, so they
# have to exist before `npm ci` rather than with the rest of the source.
COPY package.json package-lock.json ./
COPY patches ./patches
COPY scripts/ensure-electron.mjs ./scripts/ensure-electron.mjs
RUN npm ci --no-audit --no-fund
COPY tsconfig.json electron.vite.config.ts ./
COPY src ./src
COPY scripts ./scripts
# The bundle inlines documentation: stem-guide.ts and friends import
# docs/**/*.md and RELEASE_NOTES.md with `?raw`, so the build stage needs the
# actual files (screenshots stay out via .dockerignore).
COPY docs ./docs
COPY RELEASE_NOTES.md ./
# The bundle stamps every mail and turn with the version of the persona / skills
# / memory code it runs (scripts/sys-version.mjs): the three hashes come from
# src/ and need nothing more, but the git commit cannot — there is no .git in
# this stage. docker-compose.yml passes it in; an empty value simply leaves the
# `build` field off, the hashes still tell the versions apart.
ARG STEM_GIT_SHA=
ENV STEM_GIT_SHA=${STEM_GIT_SHA}
RUN npx electron-vite build

# ---- stage 2: production dependencies ----------------------------------------
#
# A second, clean install rather than pruning the first: `npm prune --omit=dev`
# leaves the devDependency tree's transitive deduplications behind, and this
# image is the thing a person `docker pull`s.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY patches ./patches
COPY scripts/ensure-electron.mjs ./scripts/ensure-electron.mjs
# `postinstall` runs patch-package, which is a devDependency and so is not
# installed by --omit=dev — the bare `npm ci` dies with `patch-package: not
# found`. Skip scripts and apply the patches with a fetched patch-package
# instead: pi-web-access is a production dependency and must ship patched.
# (ensure-electron.mjs is the other postinstall step; it exits 0 immediately
# when electron is absent, which with --omit=dev it always is.)
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
  && npx --yes patch-package@8.0.1

# ---- stage 3: what actually ships --------------------------------------------
FROM ${UV_IMAGE} AS uv

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The toolbox. `node:24-bookworm-slim` is node, npm/npx, bash and tar — and
# nothing else: no git, no curl, not even `rg`. That is the right base and the
# wrong contents for this particular container, because two things run arbitrary
# programs in it:
#
#   run_command   the assistant's shell. Stem's own tier-1 allowlist (exec/
#                 policy.ts) auto-runs `rg`, `git status`/`log`/`diff`/`show`,
#                 `file` and the coreutils — on a machine missing them, "safe
#                 enough to run without asking" means "fails without asking".
#   MCP servers   a stdio server is a command line. `uvx …` and `npx …` are what
#                 nearly every published one is distributed as, and a missing
#                 `uvx` is exactly how this was found: on a server, every Grafana
#                 MCP start died with `spawn uvx ENOENT`.
#
# So: the allowlist's programs, the two package runners, and the handful of
# things a person shells out for (curl, jq, unzip, less, ps). python3 is here
# because a Python script is still the most common thing anybody is asked to run,
# even though uv fetches its own interpreter for `uvx` (see the cache dirs below).
#
# zsh is deliberate rather than cosmetic: it is what macOS runs, what the command
# parser and the safety judge are written against, and having it means a command
# behaves the same on the server as it did on the laptop. Without it Stem falls
# back to bash, which works — that fallback is what makes this a preference.
#
# Deliberately NOT here: browsers/Playwright (~400 MB for a capability nothing in
# Stem requires), openssh-client (it would have no keys), and compilers. Adding
# your own is a `docker compose build` away — docs/running-on-a-server.md says how.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl file git jq less procps python3 ripgrep tar unzip zsh \
  && rm -rf /var/lib/apt/lists/*

# uv + uvx as their own binaries, copied from the image Astral publishes them in
# rather than installed with pip (there is no pip here, and a curl|sh into a
# layer is neither pinned nor reproducible).
COPY --from=uv /uv /uvx /usr/local/bin/

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json RELEASE_NOTES.md ./

# Where everything lives, spelled out rather than left to the defaults, because
# these paths are the container's contract with docker-compose.yml:
#
#   /var/lib/stem/state   the state root — bind-mounted from the host, backed up
#   /var/lib/stem/models  ~1.4 GB of embedding weights — a named volume, NOT here
#   /var/lib/stem/cache   what uv and npx download to run a tool — a named volume
#   /run/stem/stem.sock   the only way in, shared with Caddy
#   /run/secrets/stem_key the passphrase, a Compose secret, never in this image
#
# The model cache is pulled OUT of the state root (it would default to
# state/embed-models) on purpose. The weights are identical for everybody and
# re-downloadable; keeping them out of the bind mount is what stops every backup
# and every `rsync` of the state root from carrying a gigabyte of files that
# HuggingFace already has. It is not baked into a layer either — see the note in
# docker-compose.yml on the volume.
# STEM_KEY_FILE is deliberately NOT set: /run/secrets/stem_key is already the
# default that both the headless key wrapper and `stem-server import` look for,
# and setting it would only add a way for the two to be told different things.
#
# The cache variables move what `uvx`/`npx` download — the package, and for
# uv a whole managed CPython (~30 MB) — off HOME and under one directory the
# compose file keeps in a volume. Otherwise every `docker compose up -d` after an
# upgrade starts a fresh container with an empty cache, and the first call to
# every stdio MCP server re-downloads its world before it answers anything. Not
# in the state root: it is a cache, and backups of the state root are meant to
# stay small.
#
# cache/bin is the one part of that volume that is more than a cache: it is a
# writable bin directory that OUTLIVES the container. `uv tool install <tool>`
# puts its entry points there (UV_TOOL_BIN_DIR), and a static binary dropped in
# by hand — ffmpeg has official static builds — is picked up the same way. This
# is what makes "the assistant installed a tool" survive an upgrade, which an
# `apt-get install` into the container's own filesystem never does. Still
# disposable in the volume's sense: delete the volume and one `uv tool install`
# puts a tool back.
ENV STEM_STATE_DIR=/var/lib/stem/state \
    STEM_EMBED_MODELS_DIR=/var/lib/stem/models \
    STEM_SERVER_SOCKET=/run/stem/stem.sock \
    UV_CACHE_DIR=/var/lib/stem/cache/uv \
    UV_PYTHON_INSTALL_DIR=/var/lib/stem/cache/uv-python \
    UV_TOOL_DIR=/var/lib/stem/cache/uv-tools \
    UV_TOOL_BIN_DIR=/var/lib/stem/cache/bin \
    npm_config_cache=/var/lib/stem/cache/npm
# Its own ENV line so ${PATH} is the base image's, already resolved. This is the
# process-env PATH, which is what MCP stdio spawns inherit directly; run_command
# goes through a zsh login shell, which keeps an inherited PATH (Debian's zsh
# startup files do not reset it — its /etc/profile, which would, is bash's).
ENV PATH=/var/lib/stem/cache/bin:${PATH}
RUN mkdir -p /var/lib/stem/state /var/lib/stem/models /var/lib/stem/cache/bin /run/stem

# Root, and said out loud. The state root is a bind mount from the host, so the
# container's uid is the uid that owns the operator's files: running as a
# baked-in non-root uid means every `stem-server import`, every backup and every
# `ls` on the host has to know what that uid was. One machine, one user, one
# Stem — `user:` in docker-compose.yml is there for anyone who disagrees.
#
# It costs less than it looks: the process opens no port (a Unix socket is all it
# binds), and the only other thing in this namespace is its own state.

# No HEALTHCHECK: there is nothing to curl. Caddy in the next container is what
# has an opinion about whether this socket answers, and it says so in its log.
CMD ["node", "dist/main/server.js"]
