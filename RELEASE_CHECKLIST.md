# Release checklist: v0.10.0

Release branch: `release/v0.10.0` (from `origin/main` f422fb3). Draft PR: _not yet opened_.
Goal: close every item in the README's "Still open after the 0.9 pass" and every "Known limits"
item a text guard can close; document the rest with the control that covers it.
The v0.9.0 checklist is in git history (`git show v0.9.0:RELEASE_CHECKLIST.md`).

Status: `PASS` (evidence linked), `OPEN`, `BLOCKED` (needs owner input), `N/A`.

## Criteria

| # | Criterion (pass/fail check) | Status | Evidence / blocker |
|---|---|---|---|
| C1 | `npm ci && npm test` passes on Windows from a fresh clone of the release branch | OPEN | |
| C2 | CI "Mod tests" (Linux) passes on the release PR | OPEN | |
| C3 | Required scans pass on the release PR: Gitleaks, Checkov, Trivy, zizmor, CodeQL | OPEN | |
| C4 | Every fixable "Still open" / "Known limits" item is denied (or flagged), with a must-deny test per item | OPEN | |
| C5 | Every item left open has a one-line reason and its compensating control in the README | OPEN | |
| C6 | No existing deny relaxed; new false denies listed in the README | OPEN | |
| C7 | `plugin.json` minor bump for each changed mod; CHANGELOG 0.10.0 section | OPEN | |
| C8 | `shell.ts` copies byte-identical; fail-closed `.catch` and 4-tool coverage intact | OPEN | |
| C9 | Hostile security review of the integrated diff; findings fixed or accepted by owner | OPEN | |
| C10 | README updated (Known limits, Still open, test results) | OPEN | |
| C11 | Merge to `main`, tag `v0.10.0`, GitHub release | BLOCKED | Needs owner approval |

## Decisions

- D1 (2026-11-24) Fable (required by the owner's CLAUDE.md for guard code) is at its usage limit until
  2026-11-28 16:00 CT. The owner chose Opus implementers in parallel. A Fable re-review after the reset
  is recommended before or after tagging (owner's call).
- D2 Split: one Opus implementer per mod in its own worktree; the terraform-guard implementer owns the four
  `shell.ts` copies and adds a dynamic-program helper for supply-chain-guard. Implementers only add denies.

## Integration log

| Commit | Branch merged | Tests |
|---|---|---|
| 334687b | secret-allow-guard 0.6.0: mid-session rescan (tool.check ask, Edit/Write to settings, ConfigChange) | 164 pass |
| 9bfa476 | supply-chain-guard 0.5.0: variable/shell-named tools, python -m pip by substitution, npx -c, go get, lockfile off, poetry, conda | 626 pass |
| beeba8c | aws-guard 0.8.0: Roles Anywhere writes, cmdlet through a variable, SDK inline code | 1158 pass |
| 7073ee7 | terraform-guard 0.6.0 + shared parser: nested ${}, namedByShell, shell-filled word before terraform, variable/alias program | full `npm test` 4,843 pass, shell.ts copies match |
| 52a0ce6 | tf-lint 0.10.0: open() and Set-Item writes, action.yml anywhere, per-statement principal condition, .tf.json rules, more secret names, whole file after Edit | 781 pass |
| 4e1388b | secret-read-guard 0.6.0: PowerShell writers/expressions, Linux case, openssl/git show/compose config/tar -xO/unzip -p, recursive search/upload, quoted paths | 1,815 pass |

## Security review log

- Codex on tf-lint + secret-allow-guard: 3 confirmed findings, sent back for fixing: (1) tf-lint regression, string braces synthesize `Condition` and hide a wildcard-principal warning; (2) tf-lint whole-file recheck echoes an existing token in a finding; (3) secret-allow rescan is count-based, so a replaced secret is not reported.
- Codex findings 1-3 fixed: secret-allow 79ae2c7 (fingerprints; 166 pass), tf-lint ef2bd62 (790 pass).
- Opus reviewer on aws-guard, supply-chain-guard, terraform-guard + parser: no regressions (the DYNAMIC skip
  drops no real call; new regexes bounded; an unclosed `${` fails closed). 7 confirmed gaps in the new
  aws-guard checks (`& ${c}`, `& "$c"`, variable case, `python -Ic`/`node -pe`, ipython/deno eval, SDK code
  on stdin, boto3 resource `.delete()`); traced, unconfirmed gaps in supply-chain (lockfile env spellings,
  `${X:-npx}`, `python $M`, conda create/update/run, `go get -u`) and terraform (the `namedByShell` path
  checks only `-auto-approve`, `$TF.exe`, `sal`/`nal`, same-line function). Sent back to the three implementers.
  Fixed: supply-chain c796f57 (666 pass), aws-guard 86a6b58 (1,194 pass), terraform + parser 4b78a94 (668 pass).
  Full `npm test` at 4b78a94: 5,299 pass, 0 fail, shell.ts copies match. Left open:
  `$TF $(echo destroy -auto-approve)` (program and verb both shell-filled).
- Opus reviewer (worktree, edit access) on secret-read-guard 0.6.0: no regressions; a quadratic regex
  (60 KB input, 9.8 s) and 12 bypasses of the new denies. Fixed in cb882bd (1,934 pass), including a
  narrowing the lead asked for: a hashtable used as `-Headers`/`-Body` or assigned runs again (it ran in v0.9).
  Hook timeout (engine types): 10 s per hook, then the hook's `.catch` (1 s); every guard's `.catch` denies,
  so a timeout fails closed.
- Full `npm test` at cb882bd: 5,418 pass, 0 fail, shell.ts copies match.

## Resume here

Six implementers running. Next: review and merge each branch, `npm test`, hostile review, draft PR.
