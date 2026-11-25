# Release checklist: v0.9.0

Release branch: `release/v0.9.0` (from `origin/main` 7e7c617). Draft PR: https://github.com/DustyStudy/claude-code-guardrails/pull/84
Target: the README's commitment that "the next release will work through" the
bypasses and false positives the 0.8 hardening audit reproduced.

Status: `PASS` (evidence linked), `OPEN`, `BLOCKED` (needs owner input), `N/A`.

## Criteria

| # | Criterion (pass/fail check) | Status | Evidence / blocker |
|---|---|---|---|
| C1 | `npm ci && npm test` passes on Windows from a fresh clone of the release branch | PASS (rerun pending) | Fresh clone at c52df84: Claude Code 2.1.325, 4,500 pass. Working tree at 8bcc811: 4,523 pass. Fresh-clone rerun at the final commit: see Resume here |
| C2 | CI "Mod tests" (ubuntu, Node 24, pinned Claude Code) passes on the release PR | OPEN | Failed at c52df84 (Linux-only test fixture, fixed in 8bcc811). Result for the final commit not yet read: your CLAUDE.md says not to poll CI |
| C3 | Required scans pass on the release PR: Gitleaks, Checkov, Trivy, zizmor, CodeQL | PASS (c52df84) | All passed on c52df84; recheck with C2 |
| C4 | Every **let-through** item under README "Found by the 0.8 hardening audit" is denied, with a must-deny test (Bash and PowerShell) per item | PASS | Each item reproduced as a failing test first, then fixed; sub-case `sudo $NPM install` kept and listed in README "Still open". Per-mod reports in Integration log |
| C5 | Every **false-positive** item from that list is either allowed with a must-allow test and a hostile-review pass, or kept as a documented limit | PASS | Every loosening went through a Codex hostile review; its 7 findings are fixed with must-deny tests. Kept as limits: README "Still open" |
| C6 | Every mod whose shipped files changed has a `plugin.json` version bump (minor for more denies, patch for fixes) | PASS | aws 0.6.0→0.7.0, secret-allow 0.4.0→0.5.0, secret-read 0.4.0→0.5.0, supply-chain 0.3.0→0.4.0, terraform 0.4.0→0.5.0, tf-lint 0.8.0→0.9.0 |
| C7 | `CHANGELOG.md` has a 0.9.0 section with one line per changed mod | PASS | c52df84 |
| C8 | `hooks/shell.ts` copies are byte-identical (checked by `npm test`) | PASS | `npm test` at 750a5ce |
| C9 | Guards still fail closed: each `on(...)` ends in a deny-on-throw `.catch` | PASS | "guard failed" catch in every command/write guard (grep at 750a5ce); tests assert no "guard failed" on listed cases |
| C10 | Every command guard covers `Bash`, `PowerShell`, `Monitor`, `mcp__terminal__run_in_terminal` | PASS | `SHELL_TOOLS` in aws, secret-read, supply-chain, terraform, tf-lint |
| C11 | Workflows: `contents: read` default, actions pinned by SHA, no new permissions | PASS | `git diff 7e7c617 HEAD -- .github` empty; existing workflows already meet it |
| C12 | No open code-scanning, Dependabot or secret-scanning alerts | PASS | 2026-11-24: 0 / 0 / 0 via `gh api` |
| C13 | Independent security review of the integrated diff, findings fixed or accepted by owner | BLOCKED | Codex reviewed the loosenings in all 6 mods: 7 findings, all fixed. Not yet done: an independent re-review of the 7 fixes, and a review of the new *deny* logic (the planned Fable pass hit its usage limit). Owner decision: accept the residual risk or wait for Fable (resets 2026-11-28 16:00 CT) |
| C14 | README updated: audit section reflects what was fixed, test results summary | PASS | c52df84: "Still open after the 0.9 pass", Known limits, "Latest test results" |
| C15 | Merge to `main`, tag `v0.9.0`, GitHub release | BLOCKED | Needs owner approval (merge to default branch, publish) |

## Baseline (2026-11-24)

- `main` CI, Security Scan, CodeQL: green on 7e7c617.
- Branch protection: required checks Mod tests + 4 scans; force push off.
- Local `npm ci && npm test` (Windows, Claude Code 2.1.322): all 6 mods pass, 3,723 tests
  (aws 910, secret-allow 104, secret-read 1,484, supply-chain 332, terraform 425, tf-lint 468); 4 shell.ts copies match.
- C9 spot check: every mod's `on(...)` ends in a `.catch`. C10 to be confirmed in the integrated review.

## Decisions

- D1 (2026-11-24) Release is v0.9.0 (minor): the audit fixes make guards deny more.
- D2 Pinned dev Claude Code moved 2.1.322 → 2.1.325 (npm `stable` tag). The README's managed
  baseline needs ≥2.1.324, so CI was testing on a version the baseline itself rejects. Done by
  editing `package.json` and a bare `npm install` (supply-chain-guard correctly denied a named install).
  Evidence: unchanged mods on 2.1.325 pass the same 3,723 tests (commit 2065cee).
- D3 Work split: one Fable implementer per mod in its own worktree; the terraform-guard owner also
  owns the four `shell.ts` copies. Implementers do not touch CHANGELOG/README; the lead integrates them.
- D4 The 64 KB / 8-level nesting deny stays: it is fail-closed by design, not a defect.

- D5 aws-guard: an unquoted substitution/variable as a global option's value before the operation is
  denied (bash word-splits it); the double-quoted form stays allowed. Changes 4 former must-allow tests.
- D6 terraform-guard: `case` inside `$( )` fails closed (parser cannot model it); pipe false positive
  loosened narrowly, pending hostile review (C13).
- D7 Kept as documented limits (not fixed): supply-chain `npx tsc` and substitution-anywhere denies;
  secret-allow `--token <word>`.

## Integration log

| Commit | Branch merged | Mod tests |
|---|---|---|
| 460bc48 | secret-allow-guard 0.5.0 | 134 pass |
| e78882d | tf-lint 0.9.0 | 646 pass |
| a7e84ee | supply-chain-guard 0.4.0 | 490 pass |
| f77ffe0 | aws-guard 0.7.0 | 1,050 pass |
| bc52eab | terraform-guard 0.5.0 + shared parser | full `npm test`: 4,375 pass, 0 fail, shell.ts copies match |
| 90590fb | secret-read-guard 0.5.0 | 1,594 pass on merged parser |
| — | secret-read-guard Codex fixes (`export {,}`, dotglob, listing cost) | implementer running |

## Security review log

- Codex (gpt-6-astra, read-only) on secret-read-guard 0.5.0: 3 findings, all verified against code and
  sent back for fixing: `export {,}` env dump bypass of the new `export {` exemption (register.ts:411);
  `shopt -s dotglob; cat *` reaches `.env` (register.ts:257); unbounded `witness` work on large folders.
- Fable hostile reviewer on the other five mods: stopped by the Fable usage limit (resets 2026-11-28 16:00 CT)
  before reporting; replaced by Codex (forwarder on Sonnet).
- Codex hostile review of the loosenings, 4 findings, each confirmed by Codex as baseline-denies/HEAD-allows:
  1. terraform-guard: `f() { true | cat; terraform destroy; }; printf 'yes\n' | f` passes (pipe-rule narrowing). Real deny bypass.
  2. secret-allow-guard: `PWD=/…` inside a connection string, `TOKEN_ENDPOINT` url with `?sig=`, `DB_PASSWORD=bearer` no longer flagged.
  3. secret-allow-guard: `docker login … -p 49152:32768` read as a port mapping.
  4. tf-lint: `description = "logs # enable_key_rotation = true"` hides a missing-rotation KMS key.
  FIXED: Codex (`--write`) wrote all four fixes with must-deny tests, then hit its own usage limit before
  running tests. The lead reviewed the diff (each fix fails closed) and ran `npm test`: 4,523 pass, 0 fail.
  - CI Mod tests failed on Linux at c52df84: 10 secret-read-guard "with the folder listed" tests. Cause: the
    test's mock session folder is `C:\repos\app`, which the engine treats as relative on Linux, so the mocked
    listing never matched. Fix: the mock matches the path's tail (test-only change). Needs CI to confirm (C2).
- D8 Both Fable and Codex hit usage limits mid-release. The four review fixes were written by Codex and
  reviewed/tested by the lead; no further hostile review pass ran on them (see C13).

## Live smoke tests

- 2026-11-24 secret-read-guard wildcard listing (`$.fs.list`), real Claude Code 2.1.325 session
  (`claude -p --setting-sources project --plugin-dir <renamed copy srg-rc>`, Haiku, only `Bash(cat *)` allowed),
  folder with a fake `prod.tfvars` + `readme.txt`: `cat *` denied by `srg-rc` (the installed 0.3.1 copy lets it through).
  PASS. The copy was renamed because this machine's managed settings load another secret-read-guard first.

## Resume here

State 2026-11-24: branch `release/v0.9.0` pushed, draft PR #84. All code work is integrated and passes
locally. Two worktrees of stopped agents remain under `.claude/worktrees/` (locked by the harness; their
commits are merged); remove them with `git worktree remove -f -f` once those agents are gone.
No AWS resources were created for this release.

Next steps, in order:
1. `gh pr checks 84`: confirm Mod tests pass on Linux at the head commit (C2, C3). If the folder-listing
   tests still fail, print `e.path` in the `fs.list` mock in mods/secret-read-guard/hooks/register.test.ts.
2. Fresh clone of the head commit, `npm ci && npm test` (C1).
3. Owner: decide on C13 (accept, or run the Fable re-review after 2026-11-28 16:00 CT).
4. Owner: approve C15 (mark the PR ready, squash-merge, tag `v0.9.0`, GitHub release, and change
   `## 0.9.0 (unreleased)` in CHANGELOG to the date).
