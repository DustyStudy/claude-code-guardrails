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

## Resume here

Six implementers running. Next: review and merge each branch, `npm test`, hostile review, draft PR.
