# claude-code-guardrails

[![CI](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/ci.yml/badge.svg)](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/ci.yml)
[![Security Scan](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/security-scan.yml/badge.svg)](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/security-scan.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Guardrails for [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
when it works on AWS and Terraform. Sixteen mods that stop risky commands
before they run, stop commands that destroy work for good, lock outbound commands once a session has read untrusted
content, catch secrets before they are written, flag insecure
Terraform as it is edited, keep long command output out of the model's
context, keep subagents and Codex on the models you choose, and show how
much of your Claude and Codex plans is left.

**At a glance**

- **Problem:** an AI coding agent works at the speed of its tool calls. One
  `terraform apply -auto-approve`, one deleted IAM role or one access key
  pasted into a file is enough to do damage, and a long plan or scanner run
  fills the context the agent needs to reason about it.
- **Approach:** hooks that sit on the agent's tool calls. Guards deny the
  call and tell the model what to do instead, before anything runs. Linters
  add a note the model reads right after the edit. Tools hand the model a
  short summary in place of thousands of lines of raw output.
- **Result:** 845 tests across the sixteen mods, run in CI against a pinned
  Claude Code release. Each guard's tests pin both what it denies and the
  ordinary commands it must leave alone.

> These are guardrails against an agent's mistakes, not a security boundary.
> They read command lines and file text; a determined person, or a script
> that builds a command at run time, can get past them. Keep IAM
> permissions, SCPs and branch protection as the real controls. The known
> limits of each mod are listed [below](#known-limits).

## The mods

| Mod | Kind | Works in | What it does |
|---|---|---|---|
| [terraform-guard](mods/terraform-guard) | Guard | CLI and Desktop | Denies `terraform apply`/`destroy` with `-auto-approve`, and `apply` without a saved plan file. Covers `tofu` and `terragrunt`. |
| [aws-guard](mods/aws-guard) | Guard | CLI and Desktop | Denies AWS CLI and AWS Tools for PowerShell calls that delete IAM roles or policies, change Organizations, or destroy KMS keys, and hands the command to the user to run. |
| [destructive-guard](mods/destructive-guard) | Guard | CLI and Desktop | Denies what destroys work for good: a recursive delete outside the project or a temp folder, `git push --force` (not `--force-with-lease`), `reset --hard`, `clean -f`, `checkout .`, `stash clear`, `DROP`/`TRUNCATE`/`DELETE` without `WHERE` sent to a database client, and disk formats. |
| [taint-guard](mods/taint-guard) | Guard | CLI and Desktop | Once the session reads untrusted content (a web page, a search, an MCP result, a `curl`), denies what could send data out or publish: network tools, `git push`, `gh` and AWS writes, `terraform apply`, package publishes, untrusted MCP tools, WebFetch with a query string. A plain `gh api` GET to GitHub stays usable. You lift the lock with `/taint-clear`. |
| [tf-lint](mods/tf-lint) | Guard and linter | CLI and Desktop | Denies edits that write an AWS access key, a private key or an API token. Flags Terraform that hardcodes the `arn:aws:` partition, opens SSH/RDP to `0.0.0.0/0`, creates a KMS key without rotation or a 7-30 day deletion window, or sets a GovCloud provider without FIPS endpoints. |
| [commit-identity-guard](mods/commit-identity-guard) | Guard | CLI and Desktop | In the GitHub owners you name, denies commits and PRs carrying a Claude co-author or "Generated with Claude Code" trailer, and commits whose author or committer is not a GitHub noreply address. |
| [model-guard](mods/model-guard) | Guard | CLI and Desktop | Starts every subagent on the model you name, and denies Codex runs that leave out the flags you require, such as `--model` and `--effort`. |
| [tf-reminder](mods/tf-reminder) | Reminder | CLI only | A status line while `terraform fmt` or `validate` has not run since the last `.tf` edit, tracked per folder. |
| [tf-plan-summary](mods/tf-plan-summary) | Tool | CLI and Desktop | A `plan_summary` tool: a saved plan as counts, every destroy and replace, and IAM/KMS/security group/S3 policy changes, by attribute name only. |
| [output-trimmer](mods/output-trimmer) | Context | CLI and Desktop | Cuts long output of noisy commands (terraform, scanners, installs) to its head, error lines and tail, after saving the whole output to a file. |
| [gh-ci-status](mods/gh-ci-status) | Display and tool | CLI and Desktop | A band with the checks of your open pull requests, and Dependabot's and your workflows' (release-please) on your repositories, what holds each merge (needs approval, changes requested, a deployment protection rule holding a job, a branch rule, workflow runs waiting for approval), Merge/Rebase/Fix/Approve buttons, and a `checks` tool that returns the tail of a failing Actions log. |
| [aws-context](mods/aws-context) | Display | CLI and Desktop | The AWS profile, region and partition above the prompt, highlighted for GovCloud and for the profiles you name. |
| [cleanup-check](mods/cleanup-check) | Reminder | CLI only | A status line after each turn: a merged branch still checked out, merged branches to delete, saved plan files left behind. |
| [clean-view](mods/clean-view) | Display | CLI and Desktop | Hides tool calls and shows the agent's plan as a checklist with progress. |
| [codex-meter](mods/codex-meter) | Display and reminder | CLI; in Desktop only its notice to the model and its notification | A status line with your Codex plan's 5-hour and weekly usage and when each resets, read from Codex's own session logs. Near a limit it marks the line, notifies you once, and tells the model after each Codex run. |
| [usage-band](mods/usage-band) | Display | Desktop only | Your Claude plan's and Codex plan's 5-hour and weekly usage left above the prompt, each with when it resets: green with more than half left, orange at half or less, red at 20% or less, and LOW under 15%. Codex is there for sessions that hand work to it, such as reviews, second opinions and parallel tasks run through the Codex plugin, which spend the Codex plan rather than Claude's. Claude's figures are the ones the session reports; Codex's are read from its session logs as codex-meter reads them, and show once Codex has run in the last seven days. |

**Works in** is where each mod does its job. A mod that only hooks tool
calls, prompts and turns, or adds a tool, works the same in the CLI and in
Claude Code Desktop. On screen the two differ: both draw the band above the
prompt and the tool-call rows, but Desktop does not draw a mod's status
line under the prompt, so tf-reminder, cleanup-check and codex-meter's line
show only in the CLI. usage-band draws its band in Desktop alone, since in
the CLI the same figures belong in the status line (codex-meter's, and your
own `statusLine` command for Claude's).

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

Five mods read a setting from the same `env` block. Each is optional.
commit-identity-guard, aws-context and model-guard do nothing extra until
theirs is set.

| Variable | Mod | Value |
|---|---|---|
| `COMMIT_GUARD_OWNERS` | commit-identity-guard | Comma-separated GitHub owners whose repos the rules cover, such as `my-user,my-org`. |
| `AWS_CONTEXT_HIGHLIGHT` | aws-context | Comma-separated text that marks a sensitive profile name, such as `security,111122223333`. |
| `MODEL_GUARD_SUBAGENT_MODEL` | model-guard | The model every subagent starts on, such as `opus`. A fork always runs on the session's own model. |
| `MODEL_GUARD_CODEX_ARGS` | model-guard | The flags every Codex run must pass, written as you pass them, such as `--model gpt-6-astra --effort high`. |
| `TAINT_GUARD_TRUSTED` | taint-guard | Comma-separated MCP tool name prefixes whose results are trusted and which stay usable in a tainted session, such as `mcp__plugin_context7_,mcp__plugin_semgrep_guardian__`. clean-view's and tf-plan-summary's tools are always trusted; gh-ci-status's is not, since an Actions log carries a pull request's text. |
| `TAINT_GUARD_TRUSTED_HOSTS` | taint-guard | Comma-separated hosts whose pages a WebFetch reads without tainting the session, such as `docs.aws.amazon.com,learn.microsoft.com`. A host also covers its subdomains. Name the bare domain, not a `www.` host: WebFetch follows a redirect between the two, so a `www.` host alone is never trusted. Name only sites whose pages no outsider writes: not `github.com` or a forum. WebSearch and `curl` still taint. |
| `TAINT_GUARD_READ_SERVERS` | taint-guard | Comma-separated MCP tool name prefixes, one per server, whose read tools (named `search`, `get`, `list`, `read` or `query`) stay usable in a tainted session. Their results still taint it, and the server's other tools are still denied. A read's arguments reach that server, so name only servers no outsider runs: first-party connectors such as Gmail, and the desktop app's own `mcp__ccd_session_mgmt__,mcp__ccd_settings__`. |
| `CODEX_METER_WARN_PERCENT` | codex-meter | The used percent of a Codex window that brings the warning, 1 to 100. Default `80`. |
| `CODEX_METER_SESSION_RUNS` | codex-meter | The Codex runs one session should make, such as `2` for one review and one confirm. Past it the line says so. Not set, no run limit. |

codex-meter and usage-band read `$CODEX_HOME`, or `~/.codex` when that is not set. The
usage appears once the [Codex CLI](https://github.com/openai/codex), signed
in with a ChatGPT plan, has run on this machine in the last seven days.

## Development

```sh
npm ci      # installs the pinned Claude Code release
npm test    # runs every mod's tests, and checks the shared parser copies match
```

Each mod's tests run with `claude plugin test mods/<name>`. To type-check a
mod, open it once in a Claude Code session so the engine writes its
`.claude-plugin/types` folder (ignored by git), then run
`npx -p typescript tsc -p mods/<name>`.

terraform-guard, aws-guard, tf-reminder and model-guard each carry the same
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
- **aws-guard** covers the AWS CLI and AWS Tools for PowerShell cmdlets called
  by name. SDK scripts, and a cmdlet called through a variable, are not
  checked.
- **tf-lint** reads only the text being written, block by block. A rule split
  across edits or built from variables is missed; run Checkov on the whole
  file for that.
- **commit-identity-guard** reads a message file given with `-F`, `--file` or
  `--body-file`, but not a message piped in with `-F -`. It identifies a repo
  by its `origin` remote.
- **aws-context** takes a profile's region from the command, then the
  environment, then the profile's section of `~/.aws/config` (or
  `AWS_CONFIG_FILE`), which it rereads at most every 30 seconds. It does not
  follow `source_profile` or SSO session settings.
- **tf-reminder** follows a leading `cd`, `-chdir` and the paths given to
  `fmt`. A `cd` later in the line, `pushd` or `Set-Location` do not move it,
  and a target filled in at run time (`{}`, a variable) counts as the whole
  folder tree it runs in.
- **output-trimmer** empties saved logs older than seven days each time it
  saves one. The mod API has no file delete, so the empty files stay in
  `$TEMP/claude-output` until you delete that folder.
- **codex-meter** knows the usage as of Codex's last report, so it updates
  when Codex runs, not as time passes; a window whose reset time has passed
  reads 0%. It reads Codex's session log format, which Codex may change, and
  skips a log over 4 MiB. A run is counted by its command line.
- **model-guard** checks Codex runs made through the Codex plugin's
  companion script or the `codex` CLI by name, and reads the flags as
  written: `-m` does not stand in for `--model`, and a flag set only in
  Codex's config does not count.
- **destructive-guard** reads a delete's targets as written: a path built
  at run time, `find -delete`, a script file, or SQL in a file given with
  `-f` is not read. The project is the session's folder unless that is home
  or a drive root, where only temp folders count. A `cd` in the command adds
  its folder as a base for relative targets, in any order. Paths are compared
  as written, so a symlink or junction inside the project that points out of
  it is followed by `rm` but not by the guard. Cloud deletes
  (`aws s3 rb`, `terminate-instances`) are left to aws-guard and IAM.
- **taint-guard** cuts the blast radius of a prompt injection; it does not
  detect one. It knows the sinks by program name, so a script that opens a
  socket itself (`python -c`, `node -e`) passes, as does a file read with
  Read from a repo someone else wrote. A tainted WebFetch without a query
  string still runs, so data in a URL path or subdomain gets out; deny
  WebFetch or use `/sandbox` with a network allowlist for that. WebSearch
  stays usable: its query goes to the search provider, not to a host the
  attacker reads. It reads command lines with the shared parser, so a quoted
  argument with spaces under a wrapper (`env git -C "a b" push`) is split and
  can hide a subcommand. az and gcloud are denied whole. The lock lasts for the session; a new session starts
  clean.
- **cleanup-check** does not fetch, so a branch merged on GitHub shows once
  something runs `git fetch --prune`.
- **gh-ci-status** lists the 20 most recently updated open pull requests of
  yours and 20 of Dependabot's (on repositories you own, not an org's). A
  failing log over 4 MiB is cut by the host before the tail is taken; the
  `checks` tool says so when it happens.

## Security

See [SECURITY.md](SECURITY.md) to report a way past a guard.

## License

[MIT](LICENSE)
