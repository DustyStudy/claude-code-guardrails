# claude-code-guardrails

Claude Code mods (plugins) that deny risky commands on AWS and Terraform work. Each folder in `mods/` is one mod: `hooks/register.ts` (the guard), `hooks/register.test.ts`, `.claude-plugin/plugin.json`. The README has the full list and what each denies.

## Commands

- `npm ci` once, then `npm test` before every push. It runs every mod's tests, checks every `plugin.json`, `marketplace.json` and the managed-settings example, and checks the shared parser copies match.
- One mod: `claude plugin test mods/<name>`. The tests run through Claude Code's engine, not bun or node.
- `.claude-plugin/types/` is written by the engine when a mod is opened in a session and is git-ignored. Editor errors such as "Cannot find module 'claude-code'" without it are expected; `npm test` is the check.

## Rules that are easy to miss

- `hooks/shell.ts` is a byte-identical copy in every mod that carries it. Change one, copy it to all, or `npm test` fails. The README lists which mods have it.
- A change to what a mod ships (anything but its tests and README) bumps `version` in its `plugin.json`: patch for a fix, minor for anything else, including a guard that now denies more. A change without a bump never reaches installed copies.
- Every PR adds a line under "Unreleased" in `CHANGELOG.md`, starting with the mod's name. The README's "Versions and releases" has the rest.
- Guards deny; they never ask. In auto mode an ask is settled by the classifier, not the person. A guard that throws must also deny (the `.catch` at the end of each `on(...)`): copy the pattern from an existing mod.
- A command guard checks every tool that runs a shell: `Bash`, `PowerShell`, `Monitor` and `mcp__terminal__run_in_terminal`. A guard that lists fewer is a gap.
- Tests are lists of commands run through both Bash and PowerShell. A new deny gets a must-deny entry; a command the guard must leave alone gets a must-allow entry.
- Do not relax a guard to remove a false positive without a hostile review. Three attempts to loosen secret-read-guard each let a real secret read through (a search-line skip, a heredoc inside `$(...)`, a `-e` flag whose value looked like a flag). What survived was narrow: a quoted heredoc handed to `cat`, `tee` or `git commit`. Any change that allows a command the old code denied needs a must-deny test for each bypass found.

## Working here

- Branch from `origin/main`. `main` is protected: the mod tests and the Gitleaks, Checkov, Trivy and zizmor scans must pass, and no force push. PRs are squash-merged.
- If the machine's own guard denies a command that only mentions `.env` or `env |` as text (a PR body, a commit message), write the text to a file and pass `--body-file` or `-F`; do not reword around the guard.
- A change reaches a running Claude session only after the checkout that session loads the mod from pulls it and Claude Code restarts.
