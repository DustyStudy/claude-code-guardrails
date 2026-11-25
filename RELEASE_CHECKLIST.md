# Release checklist: v0.10.1

Release branch: `release/v0.10.1` (from `origin/main` 53be7a6). Draft PR: _pending_
Goal: release the fixes merged after v0.10.0 (PRs #88, #89), close the aws-guard gap they
left (a program the shell names), and fix every bypass the hostile reviews of this release
confirm. The v0.10.0 checklist is in git history (`git show v0.10.0:RELEASE_CHECKLIST.md`).

Status: `PASS` (evidence linked), `OPEN`, `BLOCKED` (needs owner input), `N/A`.

## Criteria

| # | Criterion (pass/fail check) | Status | Evidence / blocker |
|---|---|---|---|
| C1 | `npm ci && npm test` passes on Windows from a fresh clone of the release branch | PASS | Fresh clone at 6ddae53, Claude Code 2.1.325: 1,350 / 176 / 2,256 / 786 / 918 / 790 = 6,276 pass, 0 fail, copies match; T09/T10 310/216 ms |
| C2 | CI "Mod tests" (Linux) passes on the release PR | PASS | PR #90 at fd7071e: Mod tests pass (4m6s) |
| C3 | Required scans pass on the release PR: Gitleaks, Checkov, Trivy, zizmor (and CodeQL) | PASS | PR #90 at fd7071e: all pass, CodeQL actions + javascript-typescript pass |
| C4 | aws-guard denies a shell-named `aws` with a denied operation (`$AWS iam delete-role`, `$(which aws) ...`, `xargs -IX X iam delete-role`, `& $aws`), with must-deny tests; read-only shell-named calls (`$AWS s3 ls`) still run | PASS | 1cb6b58, 3d3cb7f; lead probes on 6ddae53 denied |
| C5 | No existing deny relaxed vs 53be7a6; new harmless denies listed in CHANGELOG/README | PASS | Codex confirm pass: 0 old-deny/new-allow in 4,322 comparisons (53be7a6 vs 1e57d0e); later fixes only add denies (each kept the as-written reading); every existing test still passes |
| C6 | `plugin.json` bump for each changed mod matches CHANGELOG; Unreleased becomes 0.10.1 | PASS | aws 0.8.3, secret-allow 0.6.1, secret-read 0.6.3, supply-chain 0.5.3, terraform 0.6.3, tf-lint 0.10.0 (unchanged); `## 0.10.1 (2026-11-25)` |
| C7 | `shell.ts` copies byte-identical; fail-closed `.catch` and 4-tool coverage intact | PASS | `npm test` copy check; Codex: all command guards list the 4 shell tools; no `hooks.json` change |
| C8 | Hostile security review of the guard diff; confirmed findings fixed or accepted by owner | PASS | Codex review (v0.9.0..53be7a6) + confirm pass (53be7a6..1e57d0e); F1-F12 fixed with must-deny tests; residual items documented in README "Still open" |
| C9 | Fable hostile review (owner's CLAUDE.md requires Fable for guard code) | N/A | Owner, 2026-11-25: use Opus until Fable resets (2026-11-28 16:00 CT); Codex review + confirm pass stand in (D7) |
| C10 | README updated (Still open, test results) | PASS | 8c7963a, counts refreshed after C1 |
| C11 | Merge to `main`, tag `v0.10.1`, GitHub release | PASS | Owner approved 2026-11-25 ("Yes, once CI passes"); squash-merged from PR #90, tag `v0.10.1` on the merge commit, GitHub release |

## Decisions

- D1 (2026-11-25) Fable is at its usage limit until 2026-11-28 16:00 CT (both Fable agents were refused
  with HTTP 429). As in v0.10.0 (D1 there), implementation went to Opus implementers and the hostile
  review to Codex (gpt-6-astra, read-only, one review + one confirm pass). C9 stays open for the owner.
- D2 Release as a patch (v0.10.1): every line closes a bypass ("denies what was wrongly let through" is a
  patch in the README's version rules), so each changed mod takes a patch bump.
- D3 Release work runs in its own worktree (`C:\repos\ccg-release`). `C:\repos\claude-code-guardrails-live`
  is the checkout the running session loads its mods from; it is not touched.
- D4 Bypasses found during the release (F5-F12) were pre-existing; all were fixed rather than deferred,
  since each is a guard letting through what it is meant to deny.
- D5 Accepted, documented, not fixed: items that need run-time values (README "Still open after the 0.10
  pass"); the quadratic `a=;a=;…` source-line check (~0.8 s at the 64 KB cap; a fix needs a quote-aware
  splitter); slow secret-read inputs such as 60 KB of ` <#` (~3.5 s). Both stay under the 10 s hook timeout,
  and a timeout runs the deny `.catch`, so they fail closed.
- D6 The secret-read T09/T10 timing tests were flaky under load (1,351/1,131 ms vs a 1 s limit). The limit
  was not raised; the guard was made faster (6ddae53: 815/532 ms to ~370/220 ms unloaded).

- D7 (2026-11-25) Owner: "don't worry about fable, we can use opus until it resets." The Fable review
  is not a release gate for v0.10.1.

## Integration log

| Commit | Change | Tests |
|---|---|---|
| 53be7a6 | Baseline (`origin/main`, PRs #88, #89 merged) | `npm ci && npm test` Windows, Claude Code 2.1.325: all 6 mods pass, copies match. Main CI + Security Scan green. 0 open code-scanning, Dependabot or secret-scanning alerts |
| 1cb6b58, 3d3cb7f | aws-guard 0.8.3: shell-named program (C4), attached inline-code flag (F3), shell-named call led by a denied operation | aws-guard 1,330 pass |
| 9c75ae3 | Parser F1, F2: xargs/parallel long-option prefixes, `source` after prefix keywords, linear `SOURCE_LINE`; terraform 0.6.3, supply-chain 0.5.3 | Full: 1,330 / 176 / 1,950 / 698 / 828 / 790, 0 fail |
| 044d8ad, afd534a, 092516b | Parser F6, supply-chain F5, secret-read 0.6.3 F4 | Full: 1,330 / 176 / 2,100 / 762 / 870 / 790, 0 fail |
| 697e2d4, 1e57d0e | Parser F7, secret-read F8 + F9 | Full: 1,330 / 176 / 2,212 / 786 / 890 / 790, 0 fail |
| 37a2368, 3b58019, 6ddae53 | aws-guard F11, parser F10, secret-read F12 + speed-up | At 3b58019 only T09/T10 failed under load (the D6 flake); see C1 for 6ddae53 |

Full-suite order: aws-guard / secret-allow-guard / secret-read-guard / supply-chain-guard / terraform-guard / tf-lint.

## Security review log

- Fable hostile review attempted 2026-11-25: refused, usage limit. See C9.
- Codex (gpt-6-astra, read-only) on `v0.9.0..53be7a6`: no regressions (603 aws + 339 supply-chain fixtures
  vs v0.9.0); 60 KB regex probes 1-17 ms; 4 shell tools covered; no hooks.json change. 4 plausible
  bypasses, all pre-existing, all confirmed by the lead on the engine (mod copies with injected must-deny
  cases, Claude Code 2.1.325).
- Findings and fixes (all pre-existing, none a regression):

| # | Mod | Bypass | Found by | Fixed in |
|---|---|---|---|---|
| F1 | parser | `xargs --rep=X` (GNU unique-prefix long option) hides the replace string | Codex | 9c75ae3 |
| F2 | parser | `time`/`!` before `source /dev/stdin <<EOF` | Codex | 9c75ae3 |
| F3 | aws-guard | `python -c"...boto3 delete..."` (code attached to the flag) | Codex | 1cb6b58 |
| F4 | secret-read | `($h = @{a=$env:GITHUB_TOKEN})` prints the credential | Codex | 092516b |
| F5 | supply-chain | `echo install \| xargs -Ici npm ci evil` (marked verb) | parser implementer | afd534a |
| F6 | parser | function/alias defined earlier in the command that sources a later heredoc | parser implementer | 044d8ad |
| F7 | parser | xargs replace strings inside a wrapper's script (`xargs -Ici sh -c 'npm ci evil'`) | supply-chain implementer | 697e2d4 |
| F8 | secret-read | `$x = @{a=$env:T}.a \| Write-Host` | secret-read implementer | 1e57d0e |
| F9 | secret-read | `ConvertTo-Json -InputObject @{a=$env:T}` | secret-read implementer | 1e57d0e |
| F10 | parser | `coproc JOB { source /dev/stdin <<EOF ... }` | Codex confirm pass | 3b58019 |
| F11 | aws-guard | `python "-cimport boto3; ...delete_role(...)"` (quoted flag) | Codex confirm pass | 37a2368 |
| F12 | secret-read | `Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject @{...}` | Codex confirm pass | 6ddae53 |

- Also fixed: `SOURCE_LINE` backtracked exponentially (`'> -x '` x24 = 638 ms; 60 KB never finished; 9c75ae3).
- Codex confirm pass (read-only) on `53be7a6..1e57d0e`: 0 old-deny/new-allow in 4,322 comparisons; no
  catastrophic backtracking; F10-F12 as above.
- Lead verification on 6ddae53: every F1-F4 and F10-F12 command, plus `$AWS iam delete-role`,
  `xargs -IX X iam delete-role`, `xargs -Isvc sh -c "aws svc delete-role ..."` and
  `xargs -Ici sh -c "$(echo npm ci evil)"`, injected as must-deny cases into copies of the mods: all denied
  under Bash and PowerShell.
- Mocked: every test runs the guards through Claude Code's engine with mocked tool calls and a mocked file
  listing; no real AWS, Terraform, npm or pip command was run.

## Resume here

Released 2026-11-25 from PR #90. Nothing left for this release; the agent worktrees and
`C:\repos\ccg-release` can be removed.
