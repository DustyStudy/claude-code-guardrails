# Changelog

## Unreleased

- aws-guard: also denies the AWS Tools for PowerShell cmdlets for the same
  calls (`Remove-IAMRole`, Organizations changes, `Request-KMSKeyDeletion`);
  `-WhatIf` passes.
- aws-context: takes a profile's region from `~/.aws/config` when no command
  or variable sets one, so a GovCloud profile is flagged before any region
  appears.
- commit-identity-guard: reads message files given with `-F`, `--file` or
  `--body-file` for Claude trailers.
- tf-reminder: tracks `fmt` and `validate` per folder, so a run in one stack
  no longer clears an edit in another; the status line names the folders.

## 0.2.0 (2026-10-22)

- output-trimmer: each save empties saved logs older than seven days, so full
  plan and scan output does not stay in the temp folder.
- codex-meter (new): a status line with the Codex plan's 5-hour and weekly
  usage from Codex's session logs, a warning near a limit, and an optional
  per-session run limit.

## 0.1.0 (2026-10-22)

First public release: eleven mods.

- Guards: terraform-guard, aws-guard, tf-lint, commit-identity-guard.
- Context and tools: tf-plan-summary, output-trimmer, gh-ci-status.
- Display and reminders: aws-context, tf-reminder, cleanup-check, clean-view.
- CI runs every mod's tests against Claude Code 2.1.309, plus Gitleaks, Checkov, Trivy and zizmor.
