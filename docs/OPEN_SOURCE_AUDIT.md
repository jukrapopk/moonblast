# Open-source readiness audit

Snapshot of the project at the time of audit (all commits on `main`).
Goal: catch personal info, absolute paths, security concerns, and
open-source hygiene gaps before publishing the repo publicly.

## Methodology

1. `git log` / `git shortlog -sn --all` — author identities across history.
2. `git config --list` + `git remote -v` — local and remote identity.
3. `git ls-files` — what's actually tracked vs. what's only on disk.
4. Grep for personal identifiers, absolute paths, secrets, and
   left-over debug code.

## Findings

### 🔴 Critical — must fix before publishing

1. **Git author identity is personal.** All 177 commits authored by
   `Jukrapop K <jukrapopk@gmail.com>`. The author email and name live
   in every commit object and are visible to anyone who clones or
   browses history on a host (GitHub, GitLab, etc.).
   - Fix: rewrite history with `git filter-repo` replacing the author
     identity across all commits, OR publish via a tooling mirror that
     strips author metadata, OR rebase and rewrite. Decide what the
     project-neutral identity should be (e.g. `Moonblast Contributors
     <dev@moonblast.app>`) before doing the rewrite.

2. **GitHub remote URL leaks the personal username.**
   `https://github.com/jukrapopk/moonblast.git` is a personal account.
   - Fix: transfer the repo to an organisation, or create a new repo
     under a different account, before making it public.

3. **No `LICENSE` file.** Without one, default copyright applies and no
   one can legally use, modify, or redistribute the code. This is the
   single biggest open-source blocker.
   - Fix: pick a license and commit `LICENSE` at the root. Candidate
     licences for a Tauri desktop app: **MIT** (permissive, matches the
     Tauri ecosystem), **GPL-3.0** (copyleft, derivative works must
     stay open), or **AGPL-3.0** (copyleft that closes the SaaS
     loophole — relevant because the project talks to remote hosts
     over the network).

### 🟡 Should fix before publishing

4. **Hardcoded Visual Studio install path.** Both
   `scripts/build-arm64.ps1` (line 41) and `README.md` (line 136)
   reference
   `D:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat`.
   Any contributor with VS on `C:\` or the Pro/Enterprise edition
   will hit a "file not found" error.
   - Fix: locate vcvarsall via `vswhere.exe` (ships with every VS
     install, reliable across editions and drive letters), or document
     the requirement and provide a clear error if vcvarsall isn't
     found at the expected location.

5. **`.gitignore` is thin.** Missing Rust/Tauri patterns:
   `target/`, `src-tauri/target/`, Cargo registry cache, `*.pdb`,
   IDE folders (`.idea/`, `*.sw?` is already covered), generated icon
   cache, `*.appx`, etc.
   - Fix: add the standard Rust + Tauri `.gitignore` patterns. No risk
     of data loss — none of those paths are currently tracked.

6. **No `CONTRIBUTING.md`.** First contributors have to guess the
   workflow. `AGENTS.md` already documents the project conventions;
   a short `CONTRIBUTING.md` pointing at it (and saying "open a PR")
   helps a lot.

7. **No CI workflow.** A `.github/workflows/build.yml` that builds on
   PR for both Windows x64 and ARM64 is a low-cost, high-value win for
   any open-source project of this size.

8. **Internal design docs at repo root.**
   `audit-2026-09-10.md` (11 KB) and `immersive-management-elevation.md`
   (6 KB) are personal engineering notes — an audit findings list and
   the shell-replacement design rationale. They're useful project
   context but belong in a `docs/` folder, not at the root.
   - Fix: move to `docs/` with descriptive filenames
     (`docs/audit-2026-09-10.md`, `docs/shell-replacement-design.md`).

### 🟢 Nice to have

9. **Git identity is global, not per-repo.** After publishing, any new
   commit you make on the public clone will still be authored under
   `Jukrapop K <jukrapopk@gmail.com>` unless you set a per-repo
   identity.
   - Fix: in the public clone,
     `git config user.name "Moonblast"` and
     `git config user.email "dev@moonblast.app"` (or similar).

10. **No `SECURITY.md`.** For a project that writes to the registry,
    kills `explorer.exe`, replaces the Windows shell, and uses COM
    elevation fallbacks, a documented place to report vulnerabilities
    is good hygiene.

11. **No issue / PR templates.** Pure polish — not blocking.

### ✅ Already clean

- No API keys, tokens, passwords, or secrets in any tracked file.
  Matches on "password" / "token" / "secret" are all legitimate
  feature code (the WiFi password-entry flow, etc.).
- No leaked personal IPs, hostnames, MAC addresses, machine names,
  or Tailscale hostnames. Matches on `192.168.*` and `*.ts.net` are
  placeholder examples in user-facing UI copy (`e.g. 192.168.1.20 or
  mybox.tailnet.ts.net`).
- No `dist/`, `target/`, `node_modules/`, or build artefacts
  accidentally committed.
- No `.env` / `.envrc` / `.env.local` files in the index.
- No leftover debug-only code paths from earlier experiments —
  `MOONBLAST_DEBUG_BATTERY`, `debugForce100`,
  `test_brightness.ps1` were all cleaned up before the audit. Only
  two `console.error` calls remain, both legitimate (caught errors
  with no UI surface).
- Bundle-identifier warning (`com.moonblast.app` ends in `.app`) is a
  cosmetic Tauri warning, not a security issue.

## Recommended sequencing

1. Decide on a licence (MIT / GPL-3.0 / AGPL-3.0) — unblocks
   everything else.
2. Decide what to do about commit history (rewrite author identity vs
   leave as-is vs publish via a metadata-stripping mirror).
3. Move / copy to the new public location (organisation account, or
   different personal account).
4. Add `LICENSE` at the root.
5. Fix `.gitignore` and the hardcoded VS path in `build-arm64.ps1` /
   `README.md`.
6. Add `CONTRIBUTING.md` pointing at `AGENTS.md`.
7. Optionally move the two design docs into `docs/`.
8. Optionally add CI (`.github/workflows/build.yml`) and
   `SECURITY.md`.
9. Optionally configure per-repo git identity for any new commits on
   the public clone.

Items 1 and 2 require a decision before any code is written.