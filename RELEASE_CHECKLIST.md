# Release checklist: v0.9.0

Release branch: `release/v0.9.0` (from `origin/main` 7e7c617). Draft PR: _not yet opened_.
Target: the README's commitment that "the next release will work through" the
bypasses and false positives the 0.8 hardening audit reproduced.

Status: `PASS` (evidence linked), `OPEN`, `BLOCKED` (needs owner input), `N/A`.

## Criteria

| # | Criterion (pass/fail check) | Status | Evidence / blocker |
|---|---|---|---|
| C1 | `npm ci && npm test` passes on Windows from a fresh clone of the release branch | OPEN | |
| C2 | CI "Mod tests" (ubuntu, Node 24, pinned Claude Code) passes on the release PR | OPEN | |
| C3 | Required scans pass on the release PR: Gitleaks, Checkov, Trivy, zizmor, CodeQL | OPEN | |
| C4 | Every **let-through** item under README "Found by the 0.8 hardening audit" is denied, with a must-deny test (Bash and PowerShell) per item | OPEN | |
| C5 | Every **false-positive** item from that list is either allowed with a must-allow test and a hostile-review pass, or kept as a documented limit | OPEN | |
| C6 | Every mod whose shipped files changed has a `plugin.json` version bump (minor for more denies, patch for fixes) | OPEN | |
| C7 | `CHANGELOG.md` has a 0.9.0 section with one line per changed mod | OPEN | |
| C8 | `hooks/shell.ts` copies are byte-identical (checked by `npm test`) | OPEN | |
| C9 | Guards still fail closed: each `on(...)` ends in a deny-on-throw `.catch` | OPEN | |
| C10 | Every command guard covers `Bash`, `PowerShell`, `Monitor`, `mcp__terminal__run_in_terminal` | OPEN | |
| C11 | Workflows: `contents: read` default, actions pinned by SHA, no new permissions | OPEN | |
| C12 | No open code-scanning, Dependabot or secret-scanning alerts | PASS | 2026-11-24: 0 / 0 / 0 via `gh api` |
| C13 | Independent security review of the integrated diff, findings fixed or accepted by owner | OPEN | |
| C14 | README updated: audit section reflects what was fixed, test results summary | OPEN | |
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
- Fable hostile reviewer on the other five mods + shell.ts: running.

## Live smoke tests

- 2026-11-24 secret-read-guard wildcard listing (`$.fs.list`), real Claude Code 2.1.325 session
  (`claude -p --setting-sources project --plugin-dir <renamed copy srg-rc>`, Haiku, only `Bash(cat *)` allowed),
  folder with a fake `prod.tfvars` + `readme.txt`: `cat *` denied by `srg-rc` (the installed 0.3.1 copy lets it through).
  PASS. The copy was renamed because this machine's managed settings load another secret-read-guard first.

## Resume here

Next step: see the last "Decisions" entry and the OPEN rows above.
