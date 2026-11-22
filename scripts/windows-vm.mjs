#!/usr/bin/env node
// Run Stem on a Windows machine over SSH, the way scripts/linux-pc.mjs does on
// Linux: the working tree (uncommitted work included) is copied over with git
// (scripts/remote-snapshot.mjs) and the command runs there. The machine needs
// OpenSSH with PowerShell as its shell, Node 24 on the user PATH, and Git for
// Windows.
//
//   STEM_WINDOWS_HOST   user@host[:port], e.g. stem@127.0.0.1:2222
//   STEM_WINDOWS_JUMP   optional jump host, e.g. join3r@192.168.1.164 (a VM
//                       whose ports are bound to that machine's loopback)
//
//   node scripts/windows-vm.mjs test [vitest args]      unit tests
//   node scripts/windows-vm.mjs e2e [playwright args]   the E2E suite
//   node scripts/windows-vm.mjs shell                   PowerShell in the copy
//   node scripts/windows-vm.mjs ps '<command>'          one PowerShell command there
//   node scripts/windows-vm.mjs desktop '<command>'     the same, inside the logged-in desktop
//                                                       session (real input, capture, UI Automation)
//   node scripts/windows-vm.mjs sync                    only copy and install
//
// Commands run in the SSH session, which has no interactive desktop: windows
// open and render, but nothing shows on the VM's screen, and input, screen
// capture and UI Automation of other apps do not work there. `desktop` runs
// its command in the console session instead, through an interactive
// scheduled task, and prints what it wrote; the user must be logged in.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BARE, PUBLIC_REPO, push, shQuote, snapshot } from './remote-snapshot.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.STEM_WINDOWS_HOST;
if (!target) {
  console.error('windows-vm: set STEM_WINDOWS_HOST (user@host[:port]), and STEM_WINDOWS_JUMP if it sits behind one');
  process.exit(2);
}
const [userHost, port = '22'] = target.split(/:(?=\d+$)/);
const jump = process.env.STEM_WINDOWS_JUMP;
const opts = [
  '-o', 'BatchMode=yes', '-o', 'VisualHostKey=no', '-o', 'StrictHostKeyChecking=accept-new',
  ...(jump ? ['-o', `ProxyCommand=ssh -o BatchMode=yes -o VisualHostKey=no -W %h:%p ${jump}`] : [])
];
const [mode = 'test', ...rest] = process.argv.slice(2);

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...o });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

const ssh = ['-p', port, ...opts, userHost];
// -EncodedCommand, not a script on stdin: `powershell -Command -` stops at the
// first block that spans lines.
const encoded = (script) => `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;

// The VM fetches the public main from GitHub; only this checkout's own commits
// and uncommitted work go over SSH (scripts/remote-snapshot.mjs).
run('ssh', [...ssh, encoded(`if (-not (Test-Path ${BARE})) { git init -q --bare ${BARE} }
git -C ${BARE} fetch -q ${PUBLIC_REPO} +refs/heads/main:refs/heads/main
if ($LASTEXITCODE -ne 0) { Write-Output 'windows-vm: could not fetch main from GitHub; sending everything' }`)]);
push(repo, snapshot(repo), { sshCommand: ['ssh', '-p', port, ...opts].map(shQuote).join(' '), remote: `${userHost}:${BARE}` });

// Runs on Windows. node_modules (the Windows builds of the native modules),
// dist and release (the last installer build) are ignored by git, so they
// survive; everything else becomes the snapshot. autocrlf stays off so files
// keep the LF endings they have on the Mac.
const prelude = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:Path = [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')
$dst = "$env:USERPROFILE\\stem"
New-Item -ItemType Directory -Force $dst | Out-Null
Set-Location $dst
if (-not (Test-Path .git)) { git init -q }
git config core.autocrlf false
git fetch -q "$env:USERPROFILE\\${BARE}" snapshot
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git reset -q --hard FETCH_HEAD
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git clean -fdq
$want = (Get-FileHash package-lock.json -Algorithm SHA256).Hash
$have = if (Test-Path node_modules\\.stem-lock) { Get-Content node_modules\\.stem-lock } else { '' }
if ($have -ne $want) {
  Write-Output 'windows-vm: npm ci (lockfile changed)'
  cmd /c 'npm ci --no-audit --no-fund 2>&1'
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Set-Content node_modules\\.stem-lock $want
}
$ErrorActionPreference = 'Continue'
`;
const args = rest.map(psQuote).join(' ');
const body = {
  sync: '',
  test: `& npx.cmd vitest run ${args}; exit $LASTEXITCODE`,
  e2e: `& npx.cmd playwright test ${args}; exit $LASTEXITCODE`,
  shell: '',
  ps: `${rest.join(' ')}\nexit $LASTEXITCODE`,
  desktop: `
$log = "$env:TEMP\\stem-desktop.log"
Remove-Item "$log", "$log.done" -ErrorAction SilentlyContinue
$script = "$env:TEMP\\stem-desktop.ps1"
Set-Content $script ("Set-Location '$dst'" + [Environment]::NewLine + "$env:Path = '$env:Path'" + [Environment]::NewLine + "& { " + [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(rest.join(' ')).toString('base64')}')) + " } *> '$log'" + [Environment]::NewLine + "Set-Content '$log.done' $LASTEXITCODE")
$action = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$script\`""
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName StemDesktop -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName StemDesktop
$deadline = (Get-Date).AddMinutes(20)
while (-not (Test-Path "$log.done") -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
Get-Content $log -ErrorAction SilentlyContinue
$code = Get-Content "$log.done" -ErrorAction SilentlyContinue
exit [int]("0" + $code)`
}[mode];
if (body === undefined) {
  console.error('usage: windows-vm.mjs test|e2e|shell|sync|ps|desktop [args]');
  process.exit(2);
}

if (mode === 'shell') {
  run('ssh', [...ssh, encoded(prelude)]);
  run('ssh', ['-t', ...ssh, 'cd $env:USERPROFILE\\stem; powershell -NoProfile']);
} else {
  run('ssh', [...ssh, encoded(prelude + body)]);
}
