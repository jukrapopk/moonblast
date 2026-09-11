# Build Moonblast for Windows x64 (portable .exe) on an x64 host.
#
# Native build — no cross-env, no LLVM. Just runs `npm run tauri build`
# on the default host target (x86_64-pc-windows-msvc) and copies the
# resulting tauri-app.exe to the destination as moonblast.exe.
#
# Run from a regular PowerShell:
#   pwsh -ExecutionPolicy Bypass -File scripts\build-portable.ps1
#   pwsh -ExecutionPolicy Bypass -File scripts\build-portable.ps1 -Destination 'Z:\'

[CmdletBinding()]
param(
  # Full path to a destination directory OR a full path ending in moonblast.exe.
  # Default: the user's Desktop (moonblast.exe).
  [string]$Destination
)

$ErrorActionPreference = "Stop"

# Walk up from this script until we find the moonblast repo root
# (a directory that contains both package.json and src-tauri/Cargo.toml).
# This way the script works no matter where it's copied — repo's scripts/,
# a temp dir, anywhere — as long as the relative layout stays intact.
function Find-RepoRoot {
  $dir = $PSScriptRoot | Split-Path -Parent
  while ($dir) {
    if ((Test-Path (Join-Path $dir 'package.json')) -and
        (Test-Path (Join-Path $dir 'src-tauri/Cargo.toml'))) {
      return $dir
    }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir) { break }
    $dir = $parent
  }
  throw "Could not locate moonblast repo root from $PSScriptRoot"
}

$repo   = Find-RepoRoot
# Native build target on this Windows x64 host. We pin the target
# explicitly so the script does the right thing on a dev machine with a
# non-default `rustup default` (e.g. aarch64-pc-windows-msvc set as the
# default toolchain would otherwise silently cross-compile).
$target = "x86_64-pc-windows-msvc"
# The cargo-built binary is named after [package].name in src-tauri/Cargo.toml
# ("tauri-app"), NOT after `productName` in tauri.conf.json ("Moonblast").
# tauri.conf.json's productName only affects bundle metadata (installer file
# names, Windows resource strings). Copy the real binary as moonblast.exe
# so the destination has a stable, recognisable name.
$exe    = Join-Path $repo "src-tauri\target\$target\release\tauri-app.exe"

# Resolve the destination: default to desktop. Accept either a full file path
# (used as-is) or a directory path (we append the canonical moonblast.exe name).
# Anything ending in a path separator is treated as a directory.
if (-not $Destination) {
  $Destination = Join-Path ([Environment]::GetFolderPath("Desktop")) "moonblast.exe"
} elseif ($Destination.EndsWith('\') -or $Destination.EndsWith('/')) {
  $Destination = Join-Path $Destination.TrimEnd('\','/') "moonblast.exe"
} elseif (-not ($Destination.EndsWith('moonblast.exe', [System.StringComparison]::OrdinalIgnoreCase))) {
  # Looks like a path without a filename — append the canonical name.
  $Destination = Join-Path $Destination "moonblast.exe"
}
$dest = $Destination

Push-Location $repo
try {
  # Bump V8's old-space heap so Vite doesn't OOM during the production
  # bundle ("Fatal process out of memory: Zone"). 8 GB is generous for our
  # bundle size (~540 kB minified) but matches the practical ceiling
  # before the V8 zone allocator complains. Anything already set in
  # NODE_OPTIONS is preserved.
  $nodeOpts = if ($env:NODE_OPTIONS) { "$env:NODE_OPTIONS --max-old-space-size=8192" }
               else { "--max-old-space-size=8192" }

  # `tauri` is the npm script alias for the @tauri-apps/cli binary.
  # Invoke via npm so PATH resolves correctly. No cross-env, no LLVM
  # — the host toolchain already targets x86_64-pc-windows-msvc.
  $cmd = "set NODE_OPTIONS=$nodeOpts && npm.cmd run tauri -- build --target $target"
  Write-Host ">>> $cmd"
  cmd /c $cmd
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }


  if (-not (Test-Path $exe)) {
    throw "Build finished but $exe was not produced"
  }

  Copy-Item -Force $exe $dest
  $info = Get-Item $dest
  Write-Host ""
  Write-Host "OK: copied to $dest"
  Write-Host ("Size: {0:N2} MB" -f ($info.Length / 1MB))
  Write-Host ("Built: {0:yyyy-MM-dd HH:mm:ss}" -f $info.LastWriteTime)
}
finally {
  Pop-Location
}