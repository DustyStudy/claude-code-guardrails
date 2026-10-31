# Changelog

## Unreleased

- Removed clean-view, tf-reminder and codex-meter, which duplicated what
  Claude Code Desktop already shows or drew only in the CLI. Desktop has its
  own task list and hides tool calls; tf-reminder's status line never showed
  there. Drop them from `CLAUDE_CODE_PLUGIN_DIRS`, and remove
  `CODEX_METER_WARN_PERCENT` and `CODEX_METER_SESSION_RUNS` if set.
- usage-band: takes over codex-meter's warning. After a Codex run with a
  window at 20% left or less, it tells the model so the next review can wait,
  and notifies you once per window.
- README: lists jev-guard.
- terraform-guard: denies `-auto-approve` passed through `TF_CLI_ARGS`,
  `TF_CLI_ARGS_apply` or `TF_CLI_ARGS_destroy`, set in the command or
  inherited.
- Shell parser (terraform-guard, aws-guard, destructive-guard, model-guard,
  taint-guard, tf-reminder): a heredoc piped to a shell (`bash <<EOF`,
  `cat <<EOF | sh`) is now read as a script. Other heredocs, like commit
  messages, are still treated as plain text.
- aws-guard: `aws iam delete-role --role-name help` is no longer mistaken for
  a help call.
- destructive-guard: each `cd` resolves from the folder the previous one
  landed in, so `cd ..; cd ..; rm -rf app/cache` is checked where it actually
  runs.
- jev-guard: denies secrets passed by variable (`$env:AWS_SECRET_ACCESS_KEY`),
  and treats a GovCloud region set on the active profile in the AWS config
  file as GovCloud work.
- tf-lint: a `tags = { ... }` map no longer hides an open management port on
  a security group rule resource.
- commit-identity-guard: checks commits run through a quoted path to git.
- clean-view, taint-guard: timer callbacks no longer leave unhandled
  rejections.
- taint-guard: once tainted, a WebFetch is denied when its URL carries data:
  a query string, userinfo, or a path segment or host label shaped like
  encoded data (base64, hex, a token). Plain docs and GitHub URLs still run,
  and hosts in `TAINT_GUARD_TRUSTED_HOSTS` always run.
- gh-ci-status: also finds workflow runs waiting for approval when other
  checks passed. Such a pull request reads "workflows need approval" with
  Approve, not "checks passed" with Merge.
- cleanup-check: a branch whose remote is gone but that git does not see as
  merged is no longer called merged. It shows as "remote is gone, delete if
  merged", since a squash merge and an unmerged delete look alike.
- commit-identity-guard: denies more than one `git commit` per command, so
  each one's repo and identity are checked. `git commit -C <commit>` and
  `--reuse-message` are checked like `--amend`: the reused author and message
  count.
- codex-meter: counts every Codex run in a command, not one per command.

- cleanup-check: works in Desktop too, where what is left to clean up shows
  in a line above the prompt, since Desktop draws no mod status lines.
- taint-guard: `/taint-clear` continues the session where it stopped, so you
  no longer type "continue" after clearing the lock.
- gh-ci-status: also lists pull requests a workflow opened (release-please)
  on repositories you own. When their workflow runs wait for approval, the row
  says "workflows need approval" and an Approve button approves them in two
  presses. Approving is a button only, so the model cannot do it.
- taint-guard: a `gh api` GET to GitHub runs in a tainted session; a method,
  field or input flag, `--hostname`, a full URL, or `GH_HOST` still deny it.
- taint-guard: `TAINT_GUARD_READ_SERVERS` names MCP servers whose read tools
  (`search`, `get`, `list`, `read`, `query`) still taint the session but stay
  usable once it is tainted.
- usage-band (new): Claude and Codex plan usage left, with reset times,
  in a band above the prompt on Claude Code Desktop, which draws no mod
  status lines. Codex's is there for work handed to Codex, which spends
  its own plan.
- README: a Works in column says which mods work in the CLI, in Desktop,
  or both.

## 0.6.0 (2026-10-28)

- taint-guard: `TAINT_GUARD_TRUSTED_HOSTS` names hosts (and their
  subdomains) whose pages a WebFetch reads without tainting the session.
- gh-ci-status: shows "needs approval", "changes requested", "awaiting
  deployment: <job>" for a job held by an environment's protection rules, and
  "blocked by a branch rule"; Merge appears only when nothing holds it.
- gh-ci-status: also lists open Dependabot pull requests on repositories you
  own, so you can review and merge them from the band.
- gh-ci-status: a pull request you merge from the band leaves it right away,
  instead of coming back with Merge while GitHub search still lists it as open.

## 0.5.0 (2026-10-24)

- destructive-guard (new): denies recursive deletes outside the project or
  a temp folder, `git push --force`, `reset --hard`, `clean -f`,
  `checkout .`, `stash clear`, `DROP`/`TRUNCATE`/`DELETE` without `WHERE`
  sent to a database client, and disk formats.

## 0.4.0 (2026-10-24)

- taint-guard (new): once a session reads untrusted content (WebFetch,
  WebSearch, an untrusted MCP tool, a `curl` or `Invoke-WebRequest`), denies
  network tools, `git push`, `gh` and AWS writes, `terraform apply`, package
  publishes, untrusted MCP tools and WebFetch with a query string until the
  user types `/taint-clear`. `TAINT_GUARD_TRUSTED` names trusted MCP tools.

## 0.3.0 (2026-10-24)

- model-guard (new): starts every subagent on the model named in
  `MODEL_GUARD_SUBAGENT_MODEL`, and denies Codex runs that leave out the flags
  in `MODEL_GUARD_CODEX_ARGS`.
- tf-lint: flags a KMS key without `enable_key_rotation = true` or a
  `deletion_window_in_days` of 7 to 30, and a GovCloud provider without
  `use_fips_endpoint = true`.
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
