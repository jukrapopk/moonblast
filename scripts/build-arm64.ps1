# Build Moonblast for Windows ARM64 (standalone .exe) on an x64 host.
#
# Loads the MSVC cross env first (vcvarsall x64_arm64), then invokes Tauri's
# build command targeting aarch64-pc-windows-msvc. The cargo-built binary
# (tauri-app.exe, named after [package].name in src-tauri/Cargo.toml) lands
# in src-tauri\target\aarch64-pc-windows-msvc\release\ and is copied to the
# destination as moonblast.exe.
#
# Run from a regular PowerShell:
#   pwsh -ExecutionPolicy Bypass -File scripts\build-arm64.ps1
#   pwsh -ExecutionPolicy Bypass -File scripts\build-arm64.ps1 -Destination 'Z:\'

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

$repo     = Find-RepoRoot

# Locate Visual Studio via `vswhere.exe`, which ships with every VS install
# (Community / Pro / Enterprise / Build Tools) regardless of drive letter or
# edition. We deliberately do NOT use `-requires VC.Tools.x86.x64` (or any
# specific workload): an ARM64 cross-build needs the ARM64 tools on top of
# x64, but a per-workload filter would just make vswhere return empty for
# installs that have a different subset, masking the real failure. Let
# vcvarsall.bat `x64_arm64` fail loudly with a clear error if the ARM64
# workload isn't present — that's the same "loud failure" UX we prefer
# elsewhere (see SECURITY.md). Falls back to the standard install path
# only as a last resort when vswhere.exe itself isn't on the machine.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
  $vsInstall = & $vswhere -latest -property installationPath
  if ($LASTEXITCODE -eq 0 -and $vsInstall) {
    $vcvars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvarsall.bat"
  } else {
    $vcvars = "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
  }
} else {
  $vcvars = "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat"
}

$target   = "aarch64-pc-windows-msvc"
# The cargo-built binary is named after [package].name in src-tauri/Cargo.toml
# ("tauri-app"), NOT after `productName` in tauri.conf.json ("Moonblast").
# tauri.conf.json's productName only affects bundle metadata (installer file
# names, Windows resource strings). Copy the real binary as moonblast.exe
# so the destination has a stable, recognisable name.
$exe      = Join-Path $repo "src-tauri\target\$target\release\tauri-app.exe"

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

if (-not (Test-Path $vcvars)) {
  throw "vcvarsall.bat not found at $vcvars (update `$vcvars in this script if VS is elsewhere)"
}

Push-Location $repo
try {
  # Target directory can hold stale rmeta/d files from a previous build that
  # cargo can't always re-mmap cleanly (typical when reusing target across
  # builds; cargo reports "found invalid metadata files for crate `windows`").
  # Wipe the affected crates so they re-fetch fresh — cheaper than wiping
  # the whole target dir and re-downloading every dependency. The manifest
  # path is required because Cargo.toml lives in src-tauri/, not the repo
  # root.
  # `aws-lc-sys` (pulled in transitively by `ureq` → `rustls`) needs
  # `clang.exe` to compile its C/asm for ARM64 cross-builds. Look it up
  # on PATH first (covers winget, scoop, portable installs, etc.); fall
  # back to the standard `C:\Program Files\LLVM\bin` location if not
  # found. Inject the resolved directory into both the `cargo clean`
  # and `cargo tauri build` invocations.
  $clangExe = Get-Command clang.exe -ErrorAction SilentlyContinue
  if ($clangExe) {
    $llvmBin = Split-Path -Parent $clangExe.Source
  } elseif (Test-Path "${env:ProgramFiles}\LLVM\bin\clang.exe") {
    $llvmBin = "${env:ProgramFiles}\LLVM\bin"
  } else {
    throw "clang.exe not found on PATH or at ${env:ProgramFiles}\LLVM\bin - install LLVM (winget install LLVM.LLVM) before building ARM64"
  }

  $cleanCmd = "set PATH=$llvmBin;%PATH% && `"$vcvars`" x64_arm64 && cargo clean --manifest-path src-tauri/Cargo.toml --target $target -p windows -p windows-sys -p windows-targets"
  Write-Host ">>> $cleanCmd"
  cmd /c $cleanCmd
  # Don't bail if clean fails — some crate names may not resolve.

  # Bump V8's old-space heap so Vite doesn't OOM during the production
  # bundle ("Fatal process out of memory: Zone"). 8 GB is generous for our
  # bundle size (~540 kB minified) but matches the practical ceiling
  # before the V8 zone allocator complains. Anything already set in
  # NODE_OPTIONS is preserved.
  $nodeOpts = if ($env:NODE_OPTIONS) { "$env:NODE_OPTIONS --max-old-space-size=8192" }
               else { "--max-old-space-size=8192" }

  # All of cargo's output is via cmd so the cross env vars stick. /c keeps
  # the call atomic; `&&` short-circuits if vcvarsall fails.
  # `cargo tauri` doesn't exist — `tauri` is the npm script alias for the
  # @tauri-apps/cli binary. Invoke via npm so PATH resolves correctly.
  $cmd = "set NODE_OPTIONS=$nodeOpts && set PATH=$llvmBin;%PATH% && `"$vcvars`" x64_arm64 && npm.cmd run tauri -- build --target $target"
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
