# Release checklist: v0.10.1

Release branch: `release/v0.10.1` (from `origin/main` 53be7a6). Draft PR: _pending_
Goal: release the fixes merged after v0.10.0 (PRs #88, #89) and close the one
remaining aws-guard bypass they surfaced (a program the shell names). The v0.10.0
checklist is in git history (`git show v0.10.0:RELEASE_CHECKLIST.md`).

Status: `PASS` (evidence linked), `OPEN`, `BLOCKED` (needs owner input), `N/A`.

## Criteria

| # | Criterion (pass/fail check) | Status | Evidence / blocker |
|---|---|---|---|
| C1 | `npm ci && npm test` passes on Windows from a fresh clone of the release branch | OPEN | |
| C2 | CI "Mod tests" (Linux) passes on the release PR | OPEN | |
| C3 | Required scans pass on the release PR: Gitleaks, Checkov, Trivy, zizmor, CodeQL | OPEN | |
| C4 | aws-guard denies a shell-named `aws` with a denied operation (`$AWS iam delete-role`, `xargs -IX X iam delete-role`), must-deny tests per form; read-only shell-named calls still run | OPEN | |
| C5 | No existing deny relaxed (v0.10.0 to release); new harmless denies listed in CHANGELOG/README | OPEN | |
| C6 | `plugin.json` bump for each changed mod matches CHANGELOG; Unreleased becomes 0.10.1 | OPEN | |
| C7 | `shell.ts` copies byte-identical; fail-closed `.catch` and 4-tool coverage intact | OPEN | |
| C8 | Hostile security review of `v0.9.0..release` guard diff; confirmed findings fixed or accepted by owner | OPEN | Codex: 4 confirmed pre-existing bypasses F1-F4, fixes in progress |
| C9 | Fable hostile review of `v0.9.0..release` (owner's CLAUDE.md requires Fable for guard code) | BLOCKED | Fable usage limit until 2026-11-28 16:00 CT |
| C10 | README updated (Still open, test results) | OPEN | |
| C11 | Merge to `main`, tag `v0.10.1`, GitHub release | BLOCKED | Needs owner approval |

## Decisions

- D1 (2026-11-25) Fable is at its usage limit until 2026-11-28 16:00 CT. As in v0.10.0 (D1 there),
  the aws-guard fix goes to an Opus implementer and the hostile review to Codex (gpt-6-astra).
  The Fable review stays open (C9) for the owner.
- D2 Release as a patch (v0.10.1): every Unreleased line closes a bypass ("denies what was wrongly
  let through" is a patch in the README's version rules), so aws-guard goes to 0.8.3.
- D3 Release work runs in its own worktree (`C:\repos\ccg-release`). `C:\repos\claude-code-guardrails-live`
  is the checkout the running session loads its mods from; it is not touched.

## Integration log

| Commit | Change | Tests |
|---|---|---|
| 53be7a6 | Baseline (`origin/main`, PRs #88, #89 merged) | `npm ci && npm test` Windows, Claude Code 2.1.325: all 6 mods pass, shell.ts copies match. Main CI + Security Scan green. 0 open code-scanning, Dependabot or secret-scanning alerts |

| 1cb6b58, 3d3cb7f | aws-guard 0.8.3: shell-named program (C4) and attached inline-code flag (F3); a shell-named call led by a denied operation (`$(which aws) $(echo iam) delete-role`) | aws-guard 1,330 pass; full `npm test` in the implementer's worktree exit 0 |
| 9c75ae3 | Shared parser (F1, F2): xargs/parallel long-option prefixes, `source` after prefix keywords, linear `SOURCE_LINE`; terraform 0.6.3, supply-chain 0.5.3 | Full `npm test` at 9c75ae3: aws 1,330 / secret-allow 176 / secret-read 1,950 / supply-chain 698 / terraform 828 / tf-lint 790, 0 fail, copies match |
| 044d8ad, afd534a, 092516b | Parser F6 (function/alias sourcing input), supply-chain F5 (marked verb), secret-read 0.6.3 F4 (parenthesized assignment) | Full `npm test` at 092516b: aws 1,330 / secret-allow 176 / secret-read 2,100 / supply-chain 762 / terraform 870 / tf-lint 790, 0 fail, copies match |

## Security review log

- Fable hostile review attempted 2026-11-25: refused, usage limit (resets 2026-11-28 16:00 CT). See C9.
- Codex (gpt-6-astra, read-only) on `v0.9.0..53be7a6` guard diff: no regressions (603 aws + 339
  supply-chain fixtures compared to v0.9.0); regex probes at 60 KB ran in 1-17 ms; all command guards
  list the 4 shell tools; no hooks.json changes. 4 plausible bypasses, all pre-existing. Lead confirmed
  all 4 on the real engine (mod copies with injected must-deny cases, Claude Code 2.1.325):
  - F1 shared parser: `xargs --rep=X` (GNU unique-prefix long option) hides the replace string. OPEN
  - F2 shared parser: `time`/`!` before `source /dev/stdin <<EOF` hides the heredoc script. OPEN
  - F3 aws-guard: `python -c"...boto3 delete..."` (code attached to the flag) skips the SDK check. OPEN
  - F4 secret-read-guard: `($h = @{a=$env:GITHUB_TOKEN})` prints the credential. OPEN
  - F5 supply-chain-guard (found by the parser implementer): `echo install | xargs -Ici npm ci evil` runs
    `npm install evil`; the parser marks the verb but the mod does not read a marked verb as an install. OPEN
  - F6 shared parser: a function/alias defined on an earlier line of the same command that runs `source`,
    then `f <<EOF`, hides the heredoc script. OPEN
  - F7 shared parser (found by the F5 implementer): xargs/parallel replace strings are not applied inside
    a wrapper's script (`echo install | xargs -Ici sh -c 'npm ci evil'`). OPEN
  - Pre-existing, fixed in 9c75ae3: `SOURCE_LINE` backtracked exponentially (`'> -x '` x24 = 638 ms; 60 KB
    never finished). A hook timeout runs the deny `.catch`, so it failed closed, but long lines were unusable.
  - F8 secret-read-guard (pre-existing, found by the F4 implementer): `$x = @{a=$env:GITHUB_TOKEN}.a | Write-Host`
    prints the credential (assigned table blanked before the printer check). OPEN
  - F9 secret-read-guard (pre-existing): a table given to a printing cmdlet's parameter
    (`ConvertTo-Json -InputObject @{a=$env:...}`) prints it. OPEN
  - Accepted, documented: pre-existing slow secret-read inputs (60 KB of ` <#` about 3.5 s), below the 10 s
    hook timeout; a timeout runs the deny `.catch`, so this fails closed.
  - F4 fixed in 092516b (also `-f`/`-join` tables, nested tables, unquoted keys in a printed table).
  - F7 fixed in 697e2d4; F8, F9 fixed in 1e57d0e. Lead re-ran its own probes on 697e2d4 (F1-F4, `$AWS`,
    `xargs -IX X`, `sh -c "$(echo npm ci evil)"`): all denied.
- Codex confirm pass (gpt-6-astra, read-only) on `53be7a6..1e57d0e`: no regressions in 4,322 old/new
  comparisons; no catastrophic backtracking. 3 pre-existing bypasses, all confirmed by the lead on the engine:
  - F10 shared parser: `coproc JOB { source /dev/stdin <<EOF ... }`. OPEN
  - F11 aws-guard: `python "-cimport boto3; ...delete_role(...)"` (quoted attached flag). OPEN
  - F12 secret-read-guard: `Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @{a=$env:T}`. OPEN
- Flaky test found by the lead: secret-read T09/T10 (60 KB) took 1,351/1,131 ms under load against a 1 s
  limit (780/513 ms unloaded). Release blocker for CI; perf fix assigned, limit not raised. OPEN
  - F1, F2 fixed in 9c75ae3; F6 fixed in 044d8ad; F5 fixed in afd534a; F3 fixed in 1cb6b58.
  - Accepted, documented: quadratic `a=;a=;…` source-line check, ~0.8 s at the 64 KB cap (bounded,
    below the 10 s hook timeout; a fix needs a quote-aware splitter).
  Assigned: F1+F2 one implementer (owns the 4 `shell.ts` copies; bumps terraform 0.6.3, supply-chain
  0.5.3); F3 with the aws-guard fix (0.8.3); F4 secret-read (0.6.3).

## Resume here

Baseline `npm test` running; aws-guard fix (Opus) and Codex review in progress.
