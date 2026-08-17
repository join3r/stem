# Windows development (experimental)

Stem’s released installers target macOS and Linux. **Windows is a terminal-first
dev port**: you can clone, install, and run from a user account **without admin
rights**, using a portable Node.js zip. Packaging (NSIS/portable exe) is not
included yet.

Personal data still lives outside the clone, under `%APPDATA%\Stem\` (and
`%APPDATA%\Stem Profiles\` for `--fresh` / `--profile=`). Reinstalling Node or
re-cloning the repo does not wipe that folder.

## Portable Node (no admin)

1. Download the **Windows x64** Node.js **24+** binary zip from
   [nodejs.org](https://nodejs.org/) (the zip, not the MSI).
2. Extract somewhere you can write, e.g. `%USERPROFILE%\tools\node-v24.x.x-win-x64`.
3. Put that folder on your PATH. Prefer a **user** PATH entry (no admin). You do
   **not** need a system-wide PATH.

### User PATH via Windows GUI (recommended for day-to-day use)

This persists for your account in new terminals and apps. No admin prompt.

1. Press **Win**, type `environment`, open **Edit environment variables for your
   account** (not “Edit the system environment variables”).
2. Under **User variables**, select **Path** → **Edit** → **New**.
3. Add the full folder that contains `node.exe`, e.g.
   `C:\Users\<you>\tools\node-v24.x.x-win-x64`
   (same path as step 2; expand `%USERPROFILE%` yourself in the dialog).
4. **OK** out of all dialogs.
5. **Close and reopen** any open terminals (and Cursor / VS Code if they were
   already running) so they pick up the new PATH.
6. Verify:

```bat
where node
node -v
npm -v
```

`where node` should list your extracted folder first.

When you upgrade Node later, edit that same user Path entry (or add a new one and
remove the old) so it points at the new extract folder.

### Session-only PATH (temporary)

Useful for a one-off check without changing account settings.

**cmd.exe (preferred when PowerShell profiles are broken):**

```bat
set PATH=%USERPROFILE%\tools\node-v24.x.x-win-x64;%PATH%
node -v
npm -v
```

**PowerShell — always skip the profile** if `profile.ps1` errors or is blocked:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$env:PATH = \"$env:USERPROFILE\tools\node-v24.x.x-win-x64;$env:PATH\"; node -v; npm -v"
```

Or open a `-NoProfile` shell first, then set PATH for that session.

## Clone and run

```bat
git clone https://github.com/join3r/stem.git
cd stem
npm install
npm run preflight
npm run dev
```

If `preflight` says Electron’s binary is missing:

```bat
node node_modules\electron\install.js
```

## Shell Stem uses for `run_command`

On Windows, approved commands run as:

`cmd.exe /d /s /c "<command>"`

- `/d` disables AutoRun (registry hooks that behave like a login profile).
- Stem does **not** load PowerShell’s `profile.ps1` for the default path.
- The command is wrapped in quotes and spawned with `windowsVerbatimArguments` so
  inner `"` (e.g. PowerShell `-Command "..."`) are not turned into `\"`.

### What auto-runs, and what doesn’t

The safety tiers are the same as on macOS, but the parser follows **cmd.exe**
rules, not zsh’s. That changes which commands can skip the safety check:

- Read-only probes auto-run: `dir`, `type`, `where`, `echo`, `cd`, `git status`
  and friends. The POSIX names (`ls`, `cat`, `grep`) are not on the Windows
  allowlist — under cmd they are not commands.
- `'` is **not** a quote character to cmd, so anything containing one goes to the
  safety check rather than auto-running. `cmd` would read `type 'a & whoami'` as
  two commands, and Stem will not auto-run something it cannot bound.
- Same for `%VAR%` (it expands before cmd parses the line) and `^` (cmd’s escape
  character). Use double quotes when you want a literal argument.
- `C:\…`, `\\server\share\…` and `%VAR%\…` paths are checked against read-only
  connected folders, so a command naming one is blocked the same way as on macOS.

If you need PowerShell from the agent, ask it to run something like:

```bat
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Write-Output hi"
```

A bare `|` is a **cmd** pipe: it splits the line before PowerShell sees it. Put
PowerShell pipelines inside `-Command "..."`:

```bat
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Select-Object -First 1 Name"
```

Or avoid pipes with `(...)` / property access when that is enough
(e.g. `(Get-Command Get-Process).Name`).

## Smoke checklist

1. `node -v` ≥ 24 and `npm -v` with portable Node on PATH.
2. `npm install` → `npm run preflight` → `npm run dev` opens Stem.
3. Complete onboarding / chat with a provider.
4. Ask Stem to run `echo hello`, `dir`, or `git status` — expect a normal result
   (or an approval card), not a spawn/`zsh` error.
5. Confirm a broken `profile.ps1` did not fire for those default commands.
6. Optional: have Stem run the `-NoProfile` PowerShell one-liner above.
7. Assisted mode: ask for `type 'a & whoami & rem '`. It must show an approval
   card, never run — cmd would split that into three commands.
8. Connect a folder read-only, then ask Stem to `type` a file inside it. Expect
   the read-only refusal, not the file.
9. Check that `%APPDATA%\Stem\` appears and survives a restart.
10. Memory / search: if hybrid embeddings fail, the reason is in
    `%APPDATA%\Stem\stem.log` (FTS-only fallback is safe but weaker). Three
    scopes cover it — grep for whichever the symptom points at:

    ```bat
    findstr /C:"[retrieval]" /C:"[embed-worker]" /C:"[embed-endpoint]" "%APPDATA%\Stem\stem.log"
    ```

    - `[retrieval]` — the model's own lifecycle: `downloading`, `loading`,
      `ready` with its dimension, or `error` with the message the Memory tab
      shows. One line per transition, so a repeated failure appears once.
    - `[embed-worker]` — the utility process: `spawned`, a `fork failed`, an
      unexpected exit (with code and uptime), a purged corrupt weights cache. A
      model that never appears as `spawned` was never asked for; one that spawns
      and exits with no `error` status aborted natively (ONNX OOM and friends),
      and the reason went with the child's stderr.
    - `[embed-endpoint]` — the named pipe serving query embeddings to the
      `stem-recall` MCP server. Failing here costs `search_past_chats` its
      semantic half and nothing else.
