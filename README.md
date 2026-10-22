# claude-code-guardrails

[![CI](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/ci.yml/badge.svg)](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/ci.yml)
[![Security Scan](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/security-scan.yml/badge.svg)](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/security-scan.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Guardrails for [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
when it works on AWS and Terraform. Eleven mods that stop risky commands
before they run, catch secrets before they are written, flag insecure
Terraform as it is edited, and keep long command output out of the model's
context.

**At a glance**

- **Problem:** an AI coding agent works at the speed of its tool calls. One
  `terraform apply -auto-approve`, one deleted IAM role or one access key
  pasted into a file is enough to do damage, and a long plan or scanner run
  fills the context the agent needs to reason about it.
- **Approach:** hooks that sit on the agent's tool calls. Guards deny the
  call and tell the model what to do instead, before anything runs. Linters
  add a note the model reads right after the edit. Tools hand the model a
  short summary in place of thousands of lines of raw output.
- **Result:** 362 tests across the eleven mods, run in CI against a pinned
  Claude Code release. Each guard's tests pin both what it denies and the
  ordinary commands it must leave alone.

> These are guardrails against an agent's mistakes, not a security boundary.
> They read command lines and file text; a determined person, or a script
> that builds a command at run time, can get past them. Keep IAM
> permissions, SCPs and branch protection as the real controls. The known
> limits of each mod are listed [below](#known-limits).

## The mods

| Mod | Kind | What it does |
|---|---|---|
| [terraform-guard](mods/terraform-guard) | Guard | Denies `terraform apply`/`destroy` with `-auto-approve`, and `apply` without a saved plan file. Covers `tofu` and `terragrunt`. |
| [aws-guard](mods/aws-guard) | Guard | Denies AWS CLI calls that delete IAM roles or policies, change Organizations, or destroy KMS keys, and hands the command to the user to run. |
| [tf-lint](mods/tf-lint) | Guard and linter | Denies edits that write an AWS access key, a private key or an API token. Flags Terraform that hardcodes the `arn:aws:` partition or opens SSH/RDP to `0.0.0.0/0`. |
| [commit-identity-guard](mods/commit-identity-guard) | Guard | In the GitHub owners you name, denies commits and PRs carrying a Claude co-author or "Generated with Claude Code" trailer, and commits whose author or committer is not a GitHub noreply address. |
| [tf-reminder](mods/tf-reminder) | Reminder | A status line while `terraform fmt` or `validate` has not run since the last `.tf` edit. |
| [tf-plan-summary](mods/tf-plan-summary) | Tool | A `plan_summary` tool: a saved plan as counts, every destroy and replace, and IAM/KMS/security group/S3 policy changes, by attribute name only. |
| [output-trimmer](mods/output-trimmer) | Context | Cuts long output of noisy commands (terraform, scanners, installs) to its head, error lines and tail, after saving the whole output to a file. |
| [gh-ci-status](mods/gh-ci-status) | Display and tool | A band with the checks of your open pull requests, Merge/Rebase/Fix buttons, and a `checks` tool that returns the tail of a failing Actions log. |
| [aws-context](mods/aws-context) | Display | The AWS profile, region and partition above the prompt, highlighted for GovCloud and for the profiles you name. |
| [cleanup-check](mods/cleanup-check) | Reminder | A status line after each turn: a merged branch still checked out, merged branches to delete, saved plan files left behind. |
| [clean-view](mods/clean-view) | Display | Hides tool calls and shows the agent's plan as a checklist with progress. |

Guards deny rather than ask: in auto mode an "ask" is settled by a
classifier, not by a person, so a deny is the only answer that reliably
reaches you.

## Install

Requires Claude Code 2.1.309 or later (the version CI tests against) and
`git`. gh-ci-status needs the [GitHub CLI](https://cli.github.com/) signed
in; tf-plan-summary needs `terraform`.

1. Clone the repository:

   ```sh
   git clone https://github.com/DustyStudy/claude-code-guardrails.git
   ```

2. List the mods you want in `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
   `~/.claude/settings.json`, separated by `;` on Windows and `:` elsewhere:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-guardrails/mods/terraform-guard:/path/to/claude-code-guardrails/mods/aws-guard:/path/to/claude-code-guardrails/mods/tf-lint"
     }
   }
   ```

3. Start a new Claude Code session. The mods load at startup.

### Settings

Two mods read a setting from the same `env` block. Both do nothing extra
until it is set.

| Variable | Mod | Value |
|---|---|---|
| `COMMIT_GUARD_OWNERS` | commit-identity-guard | Comma-separated GitHub owners whose repos the rules cover, such as `my-user,my-org`. |
| `AWS_CONTEXT_HIGHLIGHT` | aws-context | Comma-separated text that marks a sensitive profile name, such as `security,111122223333`. |

## Development

```sh
npm ci      # installs the pinned Claude Code release
npm test    # runs every mod's tests, and checks the shared parser copies match
```

Each mod's tests run with `claude plugin test mods/<name>`. To type-check a
mod, open it once in a Claude Code session so the engine writes its
`.claude-plugin/types` folder (ignored by git), then run
`npx -p typescript tsc -p mods/<name>`.

terraform-guard, aws-guard and tf-reminder each carry the same
`hooks/shell.ts`, which finds where a command line really runs a program
(through `bash -c`, `env`, `xargs`, subshells, substitutions and PowerShell
script blocks). Mods load folder by folder, so each keeps its own copy; CI
fails if the copies drift apart.

## Known limits

Each limit is also marked in the code with a `shortcut:` comment that says
when it would be worth lifting.

- **Command-line guards** (terraform-guard, aws-guard, commit-identity-guard)
  read the command as written. They do not expand shell variables or
  aliases, and a script file that runs the command itself is not read.
- **aws-guard** covers the AWS CLI. AWS Tools for PowerShell cmdlets and
  SDK scripts are not checked.
- **tf-lint** reads only the text being written, block by block. A rule split
  across edits or built from variables is missed; run Checkov on the whole
  file for that.
- **commit-identity-guard** does not read a commit message given with `-F`,
  and it identifies a repo by its `origin` remote.
- **aws-context** shows the profile and region it saw in commands or the
  environment. It does not read `~/.aws/config`, so a GovCloud profile shows
  as GovCloud only once a `us-gov-` region appears.
- **tf-reminder** keeps one reminder for the session, not one per folder: a
  `terraform fmt` in one stack clears an edit made in another.
- **output-trimmer** leaves its saved logs to the OS temp cleanup.
- **cleanup-check** does not fetch, so a branch merged on GitHub shows once
  something runs `git fetch --prune`.
- **gh-ci-status** lists the 20 most recently updated open pull requests. A
  failing log over 4 MiB is cut by the host before the tail is taken; the
  `checks` tool says so when it happens.

## Security

See [SECURITY.md](SECURITY.md) to report a way past a guard.

## License

[MIT](LICENSE)
