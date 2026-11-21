# claude-code-guardrails

[![CI](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/ci.yml/badge.svg)](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/ci.yml)
[![Security Scan](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/security-scan.yml/badge.svg)](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/security-scan.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Guardrails for [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
when it works on AWS and Terraform. Nineteen mods that stop risky commands
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
- **Result:** over a thousand tests across the nineteen mods, run in CI
  against a pinned Claude Code release. Each guard's tests pin both what it denies and the
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
| [aws-guard](mods/aws-guard) | Guard | CLI and Desktop | Denies AWS CLI and AWS Tools for PowerShell calls that turn off logging or detection (CloudTrail, GuardDuty, Config, Security Hub, log groups, flow logs), open S3 to the public, change IAM access or identities, change Organizations, weaken or destroy KMS keys, or destroy data (buckets, databases, tables, instances, backups, hosted zones), and hands the command to the user to run. |
| [supply-chain-guard](mods/supply-chain-guard) | Guard | CLI and Desktop | Denies installs of a package no lockfile or hash pins: `pip install` without `--require-hashes` (also `python -m pip` and `uv pip`), and `npm`/`pnpm`/`yarn`/`bun` install or add of a named package, and `uv add`. `npm ci`, a bare `npm install`, `pip install -e` and `uv sync` run. |
| [destructive-guard](mods/destructive-guard) | Guard | CLI and Desktop | Denies what destroys work for good: a recursive delete outside the project or a temp folder, `git push --force` (not `--force-with-lease`), `reset --hard`, `clean -f`, `checkout .`, `stash clear`, `DROP`/`TRUNCATE`/`DELETE` without `WHERE` sent to a database client, and disk formats. |
| [merged-branch-guard](mods/merged-branch-guard) | Guard | CLI and Desktop | Denies `git push` that continues a branch whose pull request is already merged (and has no open one) and which GitHub has deleted, since the push would recreate it and strand the new commits outside any PR. Long-lived branches still on the remote, such as `develop`, and new branches that reuse an old name run. The deny names the merged PR and gives the commands to move the commits to a new branch cut from the default branch. Asks GitHub through `gh`; when `gh` is missing, signed out, offline or slow, the push runs with a note. |
| [self-guard](mods/self-guard) | Guard | CLI and Desktop | Denies changes to what Claude Code loads as its own config or code: `~/.claude` (except memory, transcripts and plans), `~/.claude.json`, every folder in `CLAUDE_CODE_PLUGIN_DIRS`, and a project's `.claude/settings*.json`, whether by file tool, shell or `claude plugin`/`mcp`/`config`. Reads still run. |
| [taint-guard](mods/taint-guard) | Guard | CLI and Desktop | Once the session reads untrusted content (a web page, an MCP result, a `curl`, a `gh` view, diff, run log or `gh api` call), denies what could send data out or publish: network, DNS and ping tools, `git push`, git calls to a URL, installs from a URL or another registry, `gh` and AWS writes, `terraform apply`, package publishes, untrusted MCP tools, a WebFetch whose URL carries data (a query string, userinfo, or an encoded path segment or host label). A plain `gh api` GET to GitHub stays usable, and so does `gh pr merge` without a body, subject, author or `--admin`. You lift the lock with `/taint-clear`, and the session continues where it stopped. A WebSearch only warns: its results are marked untrusted, but it does not lock. |
| [secret-read-guard](mods/secret-read-guard) | Guard | CLI and Desktop | Denies reading a credential file into the conversation, by `Read`, `Grep` or a shell command that prints or copies it out: `.env` files, AWS, SSH, cloud CLI, npm, Docker, kube, GitHub CLI, Codex and Claude credentials, private keys (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`), Terraform state and `*.tfvars`. Also denies dumping the whole environment (`env`, `printenv`, `Get-ChildItem Env:`) and commands that print a stored credential (`aws configure get aws_secret_access_key`, `aws configure export-credentials`, `gh auth token`, `git credential fill`, `terraform state pull`). `.env.example`, `*.pub`, existence checks and programs that use a file without printing it (`terraform -var-file`, `ssh -i`) still run. |
| [tf-lint](mods/tf-lint) | Guard and linter | CLI and Desktop | Denies edits that write an AWS access key, a private key or an API token (GitHub, GitLab, npm, Slack, Anthropic, OpenAI, Stripe live, Google, Azure storage, Supabase). Flags Terraform that hardcodes the `arn:aws:` partition, opens SSH/RDP to `0.0.0.0/0`, creates a KMS key without rotation or a 7-30 day deletion window, or sets a GovCloud provider without FIPS endpoints. |
| [commit-identity-guard](mods/commit-identity-guard) | Guard | CLI and Desktop | In the GitHub owners you name, denies commits and PRs carrying a Claude co-author or "Generated with Claude Code" trailer, and commits whose author or committer is not a GitHub noreply address. |
| [model-guard](mods/model-guard) | Guard | CLI and Desktop | Starts every subagent on the model you name (moving to a fallback model and effort while it is out of usage), denies a `claude` run from the shell that names another, and denies Codex runs that leave out the flags you require, such as `--model` and `--effort`. |
| [jev-guard](mods/jev-guard) | Guard | CLI and Desktop | Denies Jev (TypeSafe) calls, and direct calls to its API, that would send a secrets, tfvars or state file, a key or token, a secret-named variable, or GovCloud/CUI work (by region, profile or folder name) to the TypeSafe API. |
| [secret-allow-guard](mods/secret-allow-guard) | Reminder | CLI and Desktop | At session start, warns when a permission rule in the project's or your own `.claude/settings*.json` holds a literal secret ("Yes, and don't ask again" saves the whole command: `PGPASSWORD=`, `sshpass -p`, `mysql -p`, a bearer token, a `user:pass@` URL, an AWS, GitHub, OpenAI, npm, Slack or Supabase key, a private key), and when the project's `settings.local.json` is tracked by git or not git-ignored. It names the file and the count, never the value. |
| [tf-plan-summary](mods/tf-plan-summary) | Tool | CLI and Desktop | A `plan_summary` tool: a saved plan as counts, every destroy and replace, and IAM/KMS/security group/S3 policy changes, by attribute name only. |
| [output-trimmer](mods/output-trimmer) | Context | CLI and Desktop | Cuts long output of noisy commands (terraform, scanners, installs) to its head, error lines and tail, after saving the whole output to a file. |
| [gh-ci-status](mods/gh-ci-status) | Display and tool | CLI and Desktop | A band with the checks of your open pull requests, and Dependabot's and your workflows' (release-please) on your repositories, what holds each merge (needs approval, changes requested, a deployment protection rule holding a job, a branch rule, workflow runs waiting for approval), Merge/Rebase/Fix/Approve buttons, and a `checks` tool that returns the tail of a failing Actions log. |
| [aws-context](mods/aws-context) | Display | CLI and Desktop | The AWS profile, region and partition above the prompt, highlighted for GovCloud and for the profiles you name. |
| [cleanup-check](mods/cleanup-check) | Reminder | CLI and Desktop | A status line after each turn (in Desktop, a line above the prompt, with a Clean up button that drafts the ask into the prompt box for you to read and send): a merged branch still checked out, merged branches to delete, saved plan files left behind, and stray keys, certificates, .env files and Terraform state not in git. Old plugin versions are left to Claude Code, which deletes each one 14 days after an update replaces it. |
| [usage-band](mods/usage-band) | Display and reminder | Desktop; the Codex warning in both | Your Claude plan's and Codex plan's 5-hour and weekly usage left above the prompt, each with when it resets: green with more than half left, orange at half or less, red at 20% or less, and LOW under 15%. Codex is there for sessions that hand work to it, such as reviews, second opinions and parallel tasks run through the Codex plugin, which spend the Codex plan rather than Claude's. Claude's figures are the ones the session reports; Codex's are read from its session logs, and show once Codex has run in the last seven days. After a Codex run with a window at 20% left or less, it tells the model so the next review can wait, and notifies you once per window. |

**Works in** is where each mod does its job. A mod that only hooks tool
calls, prompts and turns, or adds a tool, works the same in the CLI and in
Claude Code Desktop. On screen the two differ: both draw the band above the
prompt and the tool-call rows, but Desktop does not draw a mod's status
line under the prompt, so cleanup-check shows its line above the prompt
there instead. usage-band draws its band in Desktop alone, since in the CLI
the same figures belong in your own `statusLine` command.

Guards deny rather than ask: in auto mode an "ask" is settled by a
classifier, not by a person, so a deny is the only answer that reliably
reaches you.

## Install

Requires `git` and Claude Code at or above the release pinned in
[package.json](package.json), which is the release CI tests against; older
releases may lack mod APIs the mods use. gh-ci-status needs the [GitHub CLI](https://cli.github.com/) signed
in, and merged-branch-guard uses it when present; tf-plan-summary needs `terraform`.

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

   Point it at a checkout that stays on `main`, not the one you develop in:
   mods load from disk, so switching branches there changes the guards every
   session runs. A worktree does it:
   `git worktree add ../claude-code-guardrails-live main`, then
   `git -C ../claude-code-guardrails-live pull` after each merge.

3. Start a new Claude Code session. The mods load at startup.

### Deploying across an organization

The repository is also a plugin marketplace
([`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)), so
a company can install the mods from a release tag and lock them on with
[managed settings](https://code.claude.com/docs/en/managed-settings.md),
which outrank every user and project setting. In the managed settings file
(`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS,
`/etc/claude-code/managed-settings.json` on Linux,
`C:\Program Files\ClaudeCode\managed-settings.json` on Windows, or the
same JSON through MDM or claude.ai's server-managed settings):

```json
{
  "extraKnownMarketplaces": {
    "claude-code-guardrails": {
      "source": { "source": "github", "repo": "DustyStudy/claude-code-guardrails", "ref": "v0.7.0" }
    }
  },
  "enabledPlugins": {
    "terraform-guard@claude-code-guardrails": true,
    "aws-guard@claude-code-guardrails": true,
    "destructive-guard@claude-code-guardrails": true,
    "self-guard@claude-code-guardrails": true,
    "taint-guard@claude-code-guardrails": true,
    "tf-lint@claude-code-guardrails": true
  }
}
```

- **Pin `ref`** to a release tag (the marketplace ships in releases after
  v0.6.0), or to the tag's full commit SHA (Claude
  Code 2.1.324 or later) so the marketplace cannot move off what you
  reviewed. Upgrade by changing `ref` after reading the
  [changelog](CHANGELOG.md).
- **A plugin enabled in managed settings cannot be turned off** by a user:
  disabling it at their own scope leaves it loading. Settings such as
  `COMMIT_GUARD_OWNERS` go in the same file's `env` block, which also
  overrides the user's.
- **To stop users loading other plugins**, managed settings also take
  `strictKnownMarketplaces` (an allowlist of marketplace sources) and
  `disableSideloadFlags`. The second also makes Claude Code refuse to start
  while `CLAUDE_CODE_PLUGIN_DIRS` names a plugin folder, so move users off
  the clone install first, and do not list a mod both ways.
- A single user can do the same without managed settings:
  `/plugin marketplace add DustyStudy/claude-code-guardrails#v0.7.0`, then
  enable the mods in `/plugin`.

#### A managed-settings baseline

The snippet above only switches the mods on. The mods catch an agent's
mistakes; the controls a security team needs are Claude Code's own settings,
and each is off until you set it.
[`examples/managed-settings.json`](examples/managed-settings.json) sets them
together. Replace `YOUR-GITHUB-ORG`, the commit SHA and the collector URL,
then deploy it as the managed settings file at one of the three paths above.
That folder, and every folder above it, must be writable only by
administrators: anyone who can write there can rewrite the policy. Each
block, in file order:

- **`requiredMinimumVersion`** refuses to start a Claude Code older than
  2.1.324. Earlier versions do not count a mod from a GitHub marketplace as
  the organization's, so under the hooks lock below the mods would not load
  and nothing would say so.
- **`extraKnownMarketplaces`, `strictKnownMarketplaces`,
  `disableSideloadFlags`** register this marketplace at one full commit SHA,
  allow no other marketplace (the two source entries must match exactly,
  `ref` included; add an entry for each other marketplace you approve), and
  reject `--plugin-dir`, `--plugin-url`, `--agents`, `--mcp-config` and
  `CLAUDE_CODE_PLUGIN_DIRS`. Point `repo` at a fork your organization
  controls, or at `DustyStudy/claude-code-guardrails`.
- **`enabledPlugins`, `prependPlugins`** lock on the mods that deny or flag
  a mistake whoever is at the keyboard: terraform-guard, aws-guard,
  destructive-guard, self-guard, taint-guard, tf-lint, secret-allow-guard
  and commit-identity-guard (it reads `COMMIT_GUARD_OWNERS` from `env`). Add
  secret-read-guard to both lists once a release ships it. `prependPlugins`
  is what makes each one count as the organization's mod, and it must keep
  `sec-default@builtin`, Claude Code's own guard, in the list.
- **Left to each engineer**: jev-guard and model-guard enforce one person's
  choice of tools and models, and usage-band, gh-ci-status, aws-context,
  cleanup-check, output-trimmer and tf-plan-summary only display, remind or
  add a tool. None is a control, so none is locked on.
- **`allowManagedHooksOnly`** runs only the hooks and mods managed settings
  deploy, so nobody adds a hook that approves what a guard denies. It also
  stops every mod an engineer installs themselves, the personal ones above
  included. To offer those, add them to `enabledPlugins` and
  `prependPlugins` (on for everyone), or drop this key and accept user
  hooks; deny rules still win over a user's mod on a managed machine.
- **`allowManagedPermissionRulesOnly`,
  `permissions.disableBypassPermissionsMode`** ignore allow rules from user
  and project settings and from `--allowedTools`, and refuse
  `--dangerously-skip-permissions`. Engineers can no longer save "don't ask
  again", so put the allow rules your teams need in this file.
- **`permissions.deny`** blocks Claude's file tools, and the `cat`, `head`
  and redirections Claude Code recognizes in Bash, from `.env` files,
  `~/.aws/credentials`, `~/.ssh`, Terraform state, `*.tfvars` and `*.pem`. A
  Read deny also blocks Edit and Write (not NotebookEdit), so Claude cannot
  write a `.tfvars` or `.env.example` either; drop a rule you cannot live
  with. A script that
  opens the file itself is not stopped except by the sandbox, and on Linux
  the sandbox enforces only the two home-directory rules, not the `**`
  ones. `mcp__terminal__run_in_terminal` is the desktop app's tool that runs
  a command outside Bash, where no shell guard sees it; add a rule for every
  MCP tool of yours that runs commands (`mcp__<server>__<tool>`), or allow
  only named servers with `allowManagedMcpServersOnly`.
- **`sandbox`** runs Bash commands in the OS sandbox with no unsandboxed
  retry, and lets them reach only the listed hosts, which is the network
  allowlist taint-guard's limit below asks for. `allowManagedReadPathsOnly`
  stops an engineer re-opening a path the deny rules close. Trim the list: a broad host
  such as `github.com` or `*.amazonaws.com` is itself a way out. With
  `~/.ssh` denied, use HTTPS git remotes. The sandbox does not exist on
  native Windows and does not cover the WebFetch tool. WebFetch prompts for
  each new host, and nobody can save an allow rule for one; on Windows, or
  to close it everywhere, add `"WebFetch"` to `permissions.deny` (not
  `WebFetch(domain:*)`, which also empties the sandbox allowlist). On a
  macOS and Linux fleet add `"failIfUnavailable": true`, which is left out
  because it stops Claude Code starting on Windows.
- **`env`, telemetry** sends OpenTelemetry metrics and events to your
  collector, and managed settings pin the destination. `OTEL_LOG_TOOL_DETAILS`
  adds each tool call's input to tool events, so treat the collector as
  holding commands, file paths and fragments of file contents. For a
  collector token, use `otelHeadersHelper` rather than a header in this
  file. **A mod's deny is not in this telemetry.** Tested on Claude Code
  2.1.317 with the console exporter, and not re-tested on 2.1.324: a command
  destructive-guard denied produced no `tool_decision`, `tool_result` or
  hook event, while an allowed command produced the first two. (A settings
  `PreToolUse` hook's refusal is documented as a `tool_decision` with source
  `hook`; a mod's is not that.) The audit trail shows which guards were
  enabled (`plugin_loaded`, which does not prove their hooks loaded), every
  call that ran, and every call Claude Code's own checks refused, though not
  which rule refused it. A guard's denial is recorded only in the session
  transcript on the engineer's machine.
- **`cleanupPeriodDays`, `desktopSessionCleanupPeriodDays`** delete local
  transcripts after 30 days, Desktop sessions included.
- **`DISABLE_FEEDBACK_COMMAND`, `feedbackSurveyRate`, `feedbackDrafts`**
  turn off `/feedback` (and `/bug`, `/share`), the session survey with its
  offer to upload the transcript, and Claude-drafted feedback, the paths
  that send a conversation with code to Anthropic. No setting governs
  training: under Team, Enterprise and API terms Anthropic does not train on
  Claude Code prompts or code unless the organization opts in. That holds
  only for sessions signed in under the organization, which this file does
  not force; `forceLoginOrgUUID` with `forceLoginMethod` does, and a
  personal Pro or Max sign-in is under consumer terms.

Check the result on one machine with `/status` and `claude doctor`, and
with `claude --debug`, where each locked mod's `hooks module` line should
read `tier prepend`.

### Settings

Five mods read a setting from the same `env` block. Each is optional.
commit-identity-guard, aws-context and model-guard do nothing extra until
theirs is set.

| Variable | Mod | Value |
|---|---|---|
| `COMMIT_GUARD_OWNERS` | commit-identity-guard | Comma-separated GitHub owners whose repos the rules cover, such as `my-user,my-org`. |
| `AWS_CONTEXT_HIGHLIGHT` | aws-context | Comma-separated text that marks a sensitive profile name, such as `security,111122223333`. |
| `MODEL_GUARD_SUBAGENT_MODEL` | model-guard | The model every subagent starts on, such as `opus`. A fork always runs on the session's own model, as does a session started from this one; a `claude` run from the shell may name no other. |
| `MODEL_GUARD_FALLBACK_MODEL` | model-guard | The model subagents move to while `MODEL_GUARD_SUBAGENT_MODEL` is out of usage, such as `opus`. A subagent whose run on the pinned model dies on a usage or rate-limit error flags it out until the reset the error or the account's rate-limit window gives (five hours when neither does); until then every subagent request on the pinned model goes to this one, and they move back on their own after it. Forks and the main loop are left alone. Unset: no fallback. |
| `MODEL_GUARD_FALLBACK_EFFORT` | model-guard | The effort subagents run at on the fallback model: `low`, `medium`, `high`, `xhigh` or `max`. It applies to every agent type, built-in ones included. Unset: the agent's own effort. |
| `MODEL_GUARD_CODEX_ARGS` | model-guard | The flags every Codex run must pass, written as you pass them, such as `--model gpt-6-astra --effort high`. |
| `SECRET_READ_ALLOW` | secret-read-guard | Comma-separated globs of files the guard leaves readable, such as `*.pem,test/fixtures/*.key,.npmrc`. A glob with no folder matches the file name anywhere; one with folders matches the end of the path; `~` is your home folder. Use it for public certificates and fixtures, not to open `.env` everywhere. |
| `TAINT_GUARD_TRUSTED` | taint-guard | Comma-separated MCP tool name prefixes whose results are trusted and which stay usable in a tainted session, such as `mcp__plugin_context7_,mcp__plugin_semgrep_guardian__`. tf-plan-summary's tool is always trusted; gh-ci-status's is not, since an Actions log carries a pull request's text. |
| `TAINT_GUARD_TRUSTED_HOSTS` | taint-guard | Comma-separated hosts whose pages a WebFetch reads without tainting the session, such as `docs.aws.amazon.com,learn.microsoft.com`. A host also covers its subdomains. Name the bare domain, not a `www.` host: WebFetch follows a redirect between the two, so a `www.` host alone is never trusted. Name only sites whose pages no outsider writes: not `github.com` or a forum. `curl` still taints; WebSearch only warns. |
| `TAINT_GUARD_READ_SERVERS` | taint-guard | Comma-separated MCP tool name prefixes, one per server, whose read tools (named `search`, `get`, `list`, `read` or `query`) stay usable in a tainted session. Their results still taint it, and the server's other tools are still denied. A read's arguments reach that server, so name only servers no outsider runs: first-party connectors such as Gmail, and the desktop app's own `mcp__ccd_session_mgmt__,mcp__ccd_settings__`. |
| `TAINT_GUARD_BROWSER_HOSTS` | taint-guard | Comma-separated hosts, matched exactly (no subdomains), where the browser tools (Claude in Chrome and the desktop app's built-in browser) work without tainting the session, such as `create.roblox.com,www.roblox.com,roblox.com`. The guard reads each tab's address from the browser's own tab list, fresh before and after the call, never from page text: a call stays clean when its tab is on a listed host both times and any page it opens is listed (a blank new tab counts; a tab list call needs every tab listed). Once tainted, one step on such a tab still runs, and opening and closing tabs always do; page scripts (`javascript_tool`) do not. Any other site, an unknown tab, a call with no tab ID and no single active tab, or a `browser_batch` with more than one page step taints, or once tainted is denied, as before. |

usage-band reads `$CODEX_HOME`, or `~/.codex` when that is not set. The
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

terraform-guard, aws-guard, supply-chain-guard, destructive-guard, merged-branch-guard, taint-guard, model-guard, self-guard and secret-read-guard each carry the same
`hooks/shell.ts`, which finds where a command line really runs a program
(through `bash -c`, `env`, `xargs`, subshells, substitutions and PowerShell
script blocks). Mods load folder by folder, so each keeps its own copy; CI
fails if the copies drift apart.

### Versions and releases

- **Each mod has its own version**, `version` in its
  `.claude-plugin/plugin.json`, following semver. A pull request that
  changes what a mod ships (anything in its folder but tests and README)
  bumps that mod's version: patch for a fix that only lets through what
  was wrongly denied or denies what was wrongly let through, minor for
  anything else, including a new setting or a guard that now denies more.
  While a mod is below 1.0, a change that needs users to act (a renamed
  setting, a removed feature) is also a minor bump, called out in the
  changelog. Claude Code compares this version to decide whether an
  installed plugin needs updating, so a change without a bump does not
  reach marketplace installs.
- **Every pull request adds a line** under "Unreleased" in
  [CHANGELOG.md](CHANGELOG.md), starting with the mod's name.
- **The repository is released as a whole** with a `vX.Y.Z` tag: the
  Unreleased section becomes that version's section, minor if any line
  adds a mod or behaviour, patch if all are fixes. Repository and mod
  versions move independently; a tag pins every mod at the version it
  carries.
- `npm test` fails if a mod's `plugin.json` lacks `name` (matching its
  folder), an `x.y.z` `version`, `description`, `author` or `license`.

## Known limits

Each limit is also marked in the code with a `shortcut:` comment that says
when it would be worth lifting.

- **Command-line guards** (terraform-guard, aws-guard, commit-identity-guard)
  read the command as written. They do not expand shell variables or
  aliases, and a script file that runs the command itself is not read.
- **Every command guard** checks the four tools that hand a command line
  to a shell: `Bash`, `PowerShell`, `Monitor` and the desktop app's
  `mcp__terminal__run_in_terminal`. Calls made inside subagents and
  workflow agents are checked the same way. A command run by any other MCP
  tool (a server with a `command` or `script` argument) is not read: block
  such a tool by name in managed settings with
  `"permissions": { "deny": ["mcp__<server>__<tool>"] }`, or allow only the
  MCP servers you have reviewed with `allowedMcpServers`. Scheduled and
  remote runs (`CronCreate`, `RemoteTrigger`, scheduled tasks) take a
  prompt, not a command; what they run is checked wherever the mods are
  installed, which a cloud run is not unless its environment installs them.
- **aws-guard** covers the AWS CLI and AWS Tools for PowerShell cmdlets called
  by name. SDK scripts, and a cmdlet called through a variable, are not
  checked. It denies a list of known calls, not everything but reads, so a
  service or operation off the list runs: routine deploy calls
  (`iam create-role`, `cloudformation delete-stack`, `s3 sync --delete`,
  `route53 change-resource-record-sets`, security group rules) are left to
  IAM and to review. `--dry-run` and `--dryrun` are trusted as written.
- **supply-chain-guard** reads the install verbs of pip, uv, npm, pnpm, yarn
  and bun; poetry, conda and a script that installs are not checked.
- **tf-lint** reads only the text being written, block by block. A rule split
  across edits or built from variables is missed; run Checkov on the whole
  file for that.
- **secret-read-guard** keeps a secret from being read by accident; it does
  not hold against an agent set on reading one. It finds a path as written
  (whole, with `~` or a home variable, or as a `*` wildcard), so a path
  built from pieces, a symlink, a renamed copy made earlier, or a script
  file that opens the credential itself slips past. It follows the usual
  readers and the common file-reading calls handed to an interpreter
  (`open(`, `readFileSync`, `ReadAllText`), not every program that can
  print a file (`openssl`, `tar`, `git show`, `docker compose config`, `terraform show` and
  `output`, `aws secretsmanager get-secret-value`). A recursive search of
  a project folder (`grep -r x .`, the Grep tool with no path) still reads
  a `.env` there unless `.gitignore` hides it, and one variable printed by
  name (`echo $GITHUB_TOKEN`) runs. MCP file tools are not covered. It
  goes by name, so a public `*.pem` certificate or a project `.npmrc`
  with no token is denied until `SECRET_READ_ALLOW` names it. Since Edit
  needs a Read first, a guarded file can be rewritten whole but not
  edited in place. For secrets that must stay out of reach, keep them out
  of the account Claude runs as.
- **tf-lint**'s secret deny matches key formats with a fixed shape. It
  leaves out JWTs, bearer values, `password=` and `user:pass@host`, which
  in source files are mostly fixtures and local defaults; run gitleaks or
  trufflehog in CI for those.
- **commit-identity-guard** reads a message file given with `-F`, `--file` or
  `--body-file`, but not a message piped in with `-F -`. It identifies a repo
  by its `origin` remote.
- **secret-allow-guard** checks at session start, so a rule approved during
  a session is caught by the next one. It matches known key formats and
  secrets typed after a flag or variable name, so a bare password with no
  marker next to it is missed; a value written as `$VAR` passes. Ignore the
  file in every repo on the machine, including ones cloned later, with
  `git config --global core.excludesfile ~/.gitignore_global` and
  `.claude/settings.local.json` as a line in that file.
- **aws-context** takes a profile's region from the command, then the
  environment, then the profile's section of `~/.aws/config` (or
  `AWS_CONFIG_FILE`), which it rereads at most every 30 seconds. It does not
  follow `source_profile` or SSO session settings.
- **output-trimmer** empties saved logs older than seven days each time it
  saves one. The mod API has no file delete, so the empty files stay in
  `$TEMP/claude-output` until you delete that folder.
- **usage-band** knows Codex's usage as of Codex's last report, so it updates
  when Codex runs, not as time passes; a window whose reset time has passed
  reads full. It reads Codex's session log format, which Codex may change, and
  skips a log over 4 MiB. A Codex run is recognized by its command line.
- **model-guard** checks Codex runs made through the Codex plugin's
  companion script or the `codex` CLI by name, and reads the flags as
  written: `-m`, `-model` and `--model=` all count as `--model` and the last
  one wins, and a flag set only in Codex's config does not count. The companion's `review` and
  `adversarial-review` take no `--effort`, so they need only the other flags
  and run at the effort in Codex's config. The CLI has no `--effort` either:
  it takes `-c model_reasoning_effort=x`, and `-c model=x`, `-mx` and `-m=x`
  count as the model, every one of which must match; a profile, `--oss` or
  another provider is denied. A call with no subcommand is read as the
  interactive CLI when it has a plain word, so `find . -name codex -type f`
  is denied too. A `claude` run from the shell is checked for the model it
  names, not for one set in a settings file or `ANTHROPIC_MODEL`.
- **destructive-guard** reads a delete's targets as written: a path built
  at run time, `find -delete`, a script file, or SQL in a file given with
  `-f` is not read. The project is the session's folder unless that is home
  or a drive root, where only temp folders count. A `cd` in the command adds
  its folder as a base for relative targets, in any order. Paths are compared
  as written, so a symlink or junction inside the project that points out of
  it is followed by `rm` but not by the guard. Cloud deletes
  (`aws s3 rb`, `terminate-instances`) are left to aws-guard and IAM.
- **merged-branch-guard** asks `gh pr list --head <branch>` with a 5-second
  timeout, and lets the push run with a note when `gh` is missing, signed
  out, offline or slow, so it stops a mistake only while GitHub answers. It
  reads the branch from the refspec as written, or from the current branch
  for a bare `git push` or `HEAD`, as `push.default=simple` would; a branch
  pushed under another name by config, an upstream with a different name, or
  a command built at run time is not read; `--all` and `--branches` are
  checked for the current branch only, and an abbreviated option (`--del`,
  `--dry`) is not read as the full one. It asks about the repository `gh`
  resolves from the session's folder (or git's `-C`); a `cd` earlier in the
  command is not followed, and a push to a fork's remote is checked against
  the repository `gh` picks. Pushes to the default branch, tags and deletes
  are never checked. A branch name held in a variable (`git push origin
  $BRANCH`) is not expanded, so that push is not checked. It denies only
  when the branch is gone from the remote, so in a repo without
  automatic branch deletion a push to a merged branch that still exists
  runs. A new branch that reuses a merged branch's name is told apart by
  whether the merged PR's last commit is in what is pushed; after a merge
  commit (not a squash) that commit is on the default branch too, so a
  fresh branch from it under the old name is still denied.
- **taint-guard** cuts the blast radius of a prompt injection; it does not
  detect one. It knows the sinks by program name, so a script that opens a
  socket itself (`python -c`, `node -e`) passes, as does a file read with
  Read from a repo someone else wrote. A tainted WebFetch is judged by the
  shape of its URL, so a query string, userinfo, or an encoded path segment
  or host label is denied, but short or word-like data in a path or
  subdomain still gets out; deny WebFetch or use `/sandbox` with a network
  allowlist for that. Plain `git fetch`, `git pull` and `submodule update`
  reach the remotes in the repo's config, so an edit to `.git/config` or
  `.gitmodules` with the Edit tool can point them elsewhere; `npm install`
  likewise follows an `.npmrc`. `gh pr list` and other listing calls do not
  taint, though titles are third-party text. Any `gh api` call taints, even
  one that returns only your own data. WebSearch
  stays usable and does not lock: its query goes to the search provider, not
  to a host the attacker reads, but its snippets can still carry an
  injection, which then meets no lock. It reads command lines with the shared parser, so a quoted
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
