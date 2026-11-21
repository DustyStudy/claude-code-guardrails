# claude-code-guardrails

[![CI](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/ci.yml/badge.svg)](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/ci.yml)
[![Security Scan](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/security-scan.yml/badge.svg)](https://github.com/DustyStudy/claude-code-guardrails/actions/workflows/security-scan.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Guardrails for [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
when it works on AWS and Terraform. Six mods that stop risky commands
before they run, catch secrets before they are written, and flag insecure
Terraform as it is edited.

**At a glance**

- **Problem:** an AI coding agent works at the speed of its tool calls. One
  `terraform apply -auto-approve`, one deleted IAM role or one access key
  pasted into a file is enough to do damage.
- **Approach:** hooks that sit on the agent's tool calls. Guards deny the
  call and tell the model what to do instead, before anything runs. Linters
  add a note the model reads right after the edit.
- **Result:** tests across the six mods, run in CI
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
| [aws-guard](mods/aws-guard) | Guard | CLI and Desktop | Denies AWS CLI and AWS Tools for PowerShell calls that turn off logging or detection (CloudTrail, GuardDuty, Config, Security Hub, log groups, flow logs), open S3 to the public, change IAM access or identities (including SSH public keys, signing certificates, IAM Identity Center permission sets, assignments and directory users and groups, and IAM Roles Anywhere trust anchors and profiles), write static access keys to disk (`aws configure set aws_secret_access_key`, `aws configure import`, `Set-AWSCredential -StoreAs` with keys), change Organizations, weaken or destroy KMS keys, or destroy data (buckets, databases, tables, instances, backups, hosted zones), and hands the command to the user to run. |
| [supply-chain-guard](mods/supply-chain-guard) | Guard | CLI and Desktop | Denies installs of a package no lockfile or hash pins: `pip install` without `--require-hashes` (also `python -m pip` and `uv pip`), and `npm`/`pnpm`/`yarn`/`bun` install or add of a named package, and `uv add`. `npm ci`, a bare `npm install`, `pip install -e` and `uv sync` run. |
| [secret-read-guard](mods/secret-read-guard) | Guard | CLI and Desktop | Denies reading a credential file into the conversation, by `Read`, `Grep` or a shell command that prints or copies it out (`cp`, `robocopy`, `mklink`, `New-Item -ItemType SymbolicLink`, `Compress-Archive`, `tar -c`): `.env` files, AWS (`aws login`/SSO/CLI caches too), SSH, cloud CLI and Az PowerShell, npm, Docker, any file under `~/.kube`, GitHub CLI, git, Codex and Claude credentials (`~/.claude.json` too), service-account JSON keys, private keys (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.ppk`), Terraform state and `*.tfvars`. Denies sending one out (`gh gist create .env`, `curl -F f=@.env`, `aws s3 cp .env s3://…`, `Invoke-WebRequest -InFile`, `git add .env`) and a recursive search from above the home folder (`rg x C:\Users`, `grep -r x /`). Also denies dumping the whole environment (`env`, `printenv`, `Get-ChildItem Env:`, through `aws-vault exec`, `op run` or `doppler run` too), printing one variable named for a credential (`echo $GITHUB_TOKEN`, `$env:AWS_SECRET_ACCESS_KEY`), and commands that print a stored credential (`aws configure get aws_secret_access_key`, `aws secretsmanager get-secret-value`, `aws ssm get-parameter --with-decryption`, `aws ecr get-login-password`, `Get-SECSecretValue`, `gh auth token`, `git credential fill`, `terraform state pull`, `terraform output -json`, `op read`, `vault kv get`, `sops -d`, `kubectl get secret -o yaml`). `.env.example`, `*.pub`, a project's `.mcp.json`, existence checks, programs that use a file or variable without printing it (`terraform -var-file`, `ssh -i`, `curl -H "Authorization: Bearer $GITHUB_TOKEN"`, `echo $GITHUB_TOKEN \| gh auth login --with-token`) and `aws ecr get-login-password \| docker login --password-stdin` still run. |
| [tf-lint](mods/tf-lint) | Guard and linter | CLI and Desktop | Denies edits, file-writing shell commands (`>`, `tee`, heredoc, `Set-Content`) and MCP tool calls (mail, artifacts) that carry an AWS access key, a private key or an API token (GitHub, GitLab, npm, Slack, Anthropic, OpenAI, Stripe live, Google, Azure storage, Supabase). Flags Terraform that hardcodes the `arn:aws:` partition, opens SSH/RDP to `0.0.0.0/0`, creates a KMS key without rotation or a 7-30 day deletion window, sets a GovCloud provider without FIPS endpoints, creates a static `aws_iam_access_key` or an `aws_iam_user_login_profile`, creates a long-lived Google service account key or Azure application or service principal secret, trusts GitHub OIDC without a pinned repo `sub` and an `aud` condition, grants a `*` principal without a condition, grants every action (`Action "*"`) or all of `iam:*` or `sts:*`, or leaves a secret-named variable or output unmarked `sensitive` (or gives such a variable a literal default). Flags GitHub Actions workflows that pass static AWS keys instead of `role-to-assume`, or a stored Azure or Google credential instead of workload identity federation. |
| [secret-allow-guard](mods/secret-allow-guard) | Reminder | CLI and Desktop | At session start, warns when a permission rule, an `env` value or an MCP server's `env` or `headers` value holds a literal secret, in the project's or your own `.claude/settings*.json`, `~/.claude.json` (yours and every project's MCP servers) or the project's `.mcp.json` ("Yes, and don't ask again" saves the whole command: `PGPASSWORD=`, `sshpass -p`, `mysql -p`, a bearer token, a `user:pass@` URL, an AWS, GitHub, OpenAI, npm, Slack or Supabase key, a private key), and when the project's `settings.local.json` is tracked by git or not git-ignored. It names the file and the count, never the value. |

**Works in** is where each mod does its job. A mod that only hooks tool calls, prompts and turns works the same in the CLI and in Claude Code Desktop.

Guards deny rather than ask: in auto mode an "ask" is settled by a
classifier, not by a person, so a deny is the only answer that reliably
reaches you.

## Install

Requires `git` and Claude Code at or above the release pinned in
[package.json](package.json), which is the release CI tests against; older
releases may lack mod APIs the mods use.

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
  `SECRET_READ_ALLOW` go in the same file's `env` block, which also
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
together. Replace `YOUR-GITHUB-ORG`, the commit SHA, the organization UUID
and the collector URL, then deploy it as the managed settings file at one
of the three paths above. That folder, and every folder above it, must be
writable only by administrators: anyone who can write there can rewrite the policy. Each
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
  tf-lint, secret-allow-guard and secret-read-guard. `prependPlugins`
  is what makes each one count as the organization's mod, and it must keep
  `sec-default@builtin`, Claude Code's own guard, in the list.
- **`allowManagedHooksOnly`** runs only the hooks and mods managed settings
  deploy, so nobody adds a hook that approves what a guard denies. It also
  stops every mod an engineer installs themselves. To offer one, add it to `enabledPlugins` and
  `prependPlugins` (on for everyone), or drop this key and accept user
  hooks; deny rules still win over a user's mod on a managed machine.
- **`allowManagedPermissionRulesOnly`,
  `permissions.disableBypassPermissionsMode`** ignore allow rules from user
  and project settings and from `--allowedTools`, and refuse
  `--dangerously-skip-permissions`. Engineers can no longer save "don't ask
  again", so put the allow rules your teams need in this file.
- **`permissions.deny`** blocks Claude's file tools, and the `cat`, `head`
  and redirections Claude Code recognizes in Bash, from `.env` files,
  `~/.aws/credentials`, `~/.ssh`, Terraform state, `*.tfvars` and `*.pem`.
  It also covers the Azure and Google Cloud CLI token caches, the kube,
  docker, git, npm, PyPI, Vault and Terraform credential files, Claude's and
  Codex's own sign-ins, and private-key formats (`*.key`, `*.p12`, `*.pfx`,
  `*.ppk`, `*.jks`, `*.keystore`), with the Windows `AppData` paths for
  gcloud and Terraform. The AWS SSO and CLI caches and gh's sign-in are left
  readable so Claude can run `aws` and `gh` from the sandbox on short-lived
  credentials; secret-read-guard keeps their contents out of the
  conversation. A
  Read deny also blocks Edit and Write (not NotebookEdit), so Claude cannot
  write a `.tfvars` or `.env.example` either; drop a rule you cannot live
  with. A script that
  opens the file itself is not stopped except by the sandbox, and on Linux
  the sandbox enforces only the home-directory rules, not the `**`
  ones. `mcp__terminal__run_in_terminal` is the desktop app's tool that runs
  a command outside Bash, where no shell guard sees it; add a rule for every
  MCP tool of yours that runs commands (`mcp__<server>__<tool>`), or allow
  only named servers with `allowManagedMcpServersOnly`.
  The same list replaces the removed destructive-guard and self-guard. A
  deny always beats an allow, so `--force-with-lease` stays usable only
  because each force flag is written as a whole word (`git push --force`,
  `git push * --force *`, and so on) rather than as `--force*`. Write each
  git rule for `PowerShell(...)` as well as `Bash(...)`, and add a `git -C *`
  twin, which a plain `git push` rule does not match. `Edit(~/.claude/**)`
  would also block Claude's memory and plan writes, so the list names
  `settings`, `CLAUDE.md`, `agents`, `skills`, `commands` and `plugins`
  instead. A combined flag such as `-fu` and a `+branch` refspec still pass.
- **`allowManagedMcpServersOnly`, `allowedMcpServers`** load only the MCP
  servers this file lists. An MCP server holds a token for the service it
  reaches, so list each server after you review it, by `serverName`,
  `serverUrl` or `serverCommand`. The list is empty, so no MCP server loads
  until you add one.
- **`forceLoginMethod`, `forceLoginOrgUUID`** require a claude.ai sign-in to
  your organization, so every session runs under its terms and its admin
  controls. Replace the UUID with your organization's. A fleet that uses
  Bedrock, Vertex or an API key instead drops both keys.
- **`sandbox`** runs Bash commands in the OS sandbox with no unsandboxed
  retry, and lets them reach only the listed hosts, which keeps a prompt injection from sending data out. `allowManagedReadPathsOnly`
  stops an engineer re-opening a path the deny rules close. Trim the list: a broad host
  such as `github.com` or `*.amazonaws.com` is itself a way out. With
  `~/.ssh` denied, use HTTPS git remotes. The sandbox does not exist on
  native Windows and does not cover the WebFetch tool. WebFetch prompts for
  each new host, and nobody can save an allow rule for one; on Windows, or
  to close it everywhere, add `"WebFetch"` to `permissions.deny` (not
  `WebFetch(domain:*)`, which also empties the sandbox allowlist). On a
  macOS and Linux fleet add `"failIfUnavailable": true`, which is left out
  because it stops Claude Code starting on Windows.
  `credentials.envVars` removes static keys and token variables from
  sandboxed commands' environment, so a script that reads one itself, which
  no command-line guard sees, gets nothing; `aws` then signs in through an
  SSO profile, not keys in the environment. The home-folder `Read` denies
  above already reach the sandbox, so `credentials.files` is not repeated.
  kubectl, docker and az cannot sign in from a sandboxed command; drop the
  rules your teams need. This applies to sandboxed Bash only, not native
  Windows. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`
  is not set: it also forces the default permission mode, and is meant for
  CI.
- **`env`, telemetry** sends OpenTelemetry metrics and events to your
  collector, and managed settings pin the destination. `OTEL_LOG_TOOL_DETAILS`
  adds each tool call's input to tool events, so treat the collector as
  holding commands, file paths and fragments of file contents. For a
  collector token, use `otelHeadersHelper` rather than a header in this
  file. **A mod's deny is not in this telemetry.** Tested on Claude Code
  2.1.317 with the console exporter, and not re-tested on 2.1.324: a command
  a mod denied produced no `tool_decision`, `tool_result` or
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
  only for sessions signed in under the organization, which
  `forceLoginOrgUUID` with `forceLoginMethod` above forces; a personal Pro
  or Max sign-in is under consumer terms.

Check the result on one machine with `/status` and `claude doctor`, and
with `claude --debug`, where each locked mod's `hooks module` line should
read `tier prepend`.

### Settings

Some mods read a setting from the same `env` block. Each is optional.

| Variable | Mod | Value |
|---|---|---|
| `SECRET_READ_ALLOW` | secret-read-guard | Comma-separated globs of files the guard leaves readable, such as `*.pem,test/fixtures/*.key,.npmrc`. A glob with no folder matches the file name anywhere; one with folders matches the end of the path; `~` is your home folder. Use it for public certificates and fixtures, not to open `.env` everywhere. |

## Development

```sh
npm ci      # installs the pinned Claude Code release
npm test    # runs every mod's tests, and checks the shared parser copies match
```

Each mod's tests run with `claude plugin test mods/<name>`. To type-check a
mod, open it once in a Claude Code session so the engine writes its
`.claude-plugin/types` folder (ignored by git), then run
`npx -p typescript tsc -p mods/<name>`.

terraform-guard, aws-guard, supply-chain-guard and secret-read-guard each carry the same
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

- **Command-line guards** (terraform-guard, aws-guard)
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
  The interactive `aws configure` wizard runs, since it needs a terminal
  the agent does not have. Every `sso-admin` call but a read is denied,
  tags included. Roles Anywhere CRL and attribute-mapping calls, and the
  CLI's `rolesanywhere delete-*`, run (its `Remove-IAMRA*` cmdlets are
  denied with the other `Remove-IAM*`). In PowerShell a parenthesized
  argument ends the call for the shell parser, so an AWS CLI call such as
  `aws --profile ($p) iam delete-role` or `aws s3 rm ($p) --recursive`
  runs; the cmdlets denied only by their arguments (`-StoreAs`,
  `-Terminate`) are also read from the text, so a later mention of the
  cmdlet's name in the same command can be denied too.
- **supply-chain-guard** reads the install verbs of pip, uv, npm, pnpm, yarn
  and bun; poetry, conda and a script that installs are not checked.
- **tf-lint** reads only the text being written, block by block. A rule split
  across edits or built from variables is missed; run Checkov on the whole
  file for that. An edit that changes only a trust policy's `sub` values,
  out of sight of its `token.actions.githubusercontent.com` principal, is
  not checked, and the wildcard-principal check looks for any condition in
  the text, not one per statement. In `.tf.json` it finds the
  `aws_iam_access_key` and `aws_iam_user_login_profile` resources, but the
  KMS, provider, port, variable and trust checks read HCL syntax only. It
  reads workflows only under `.github/workflows/`, so a composite action
  kept elsewhere is not checked; a static key there is flagged even next to
  `role-to-assume`, since that chains from a static key, while a key taken
  from a `steps.`, `needs.` or `env.` output passes as a temporary one. Variables and
  outputs are judged by name: `api_token_url` is flagged, a secret held in
  `db_creds` is not.
- **secret-read-guard** keeps a secret from being read by accident; it does
  not hold against an agent set on reading one. It finds a path as written
  (whole, with `~` or a home variable, or as a `*` wildcard), so a path
  built from pieces, a symlink, a renamed copy made earlier, or a script
  file that opens the credential itself slips past. It follows the usual
  readers and the common file-reading calls handed to an interpreter
  (`open(`, `readFileSync`, `ReadAllText`), not every program that can
  print a file (`openssl`, `tar -x` then `cat`, `git show`, `git diff`, `docker compose config`). A recursive search of
  a project folder (`grep -r x .`, the Grep tool with no path) still reads
  a `.env` there unless `.gitignore` hides it; `aws s3 sync .` uploads one
  too. A variable is judged by its name, so `echo $DB_CONN` runs even when
  it holds a password, and one printed by a program the guard does not
  know runs, while a quoted literal (`echo '$GITHUB_TOKEN'`) is denied. A
  `git add` or `gh gist create` path with a space in it is read as a
  message and slips past. It also
  denies `aws secretsmanager create-secret --secret-string file://.env`,
  `terraform output -raw vpc_id` and `terraform show -json plan.out`,
  where the credential goes to AWS or nothing secret would print. MCP file tools are not covered. It
  goes by name, so a public `*.pem` certificate or a project `.npmrc`
  with no token is denied until `SECRET_READ_ALLOW` names it. Since Edit
  needs a Read first, a guarded file can be rewritten whole but not
  edited in place. For secrets that must stay out of reach, keep them out
  of the account Claude runs as.
- **tf-lint**'s secret deny matches key formats with a fixed shape. It
  leaves out JWTs, bearer values, `password=` and `user:pass@host`, which
  in source files are mostly fixtures and local defaults; run gitleaks or
  trufflehog in CI for those. In a shell command it checks only one that
  writes a file (`>`, `>>`, `tee`, a heredoc, `Set-Content`, `Add-Content`,
  `Out-File`); a key built from pieces, or written by a script the command
  runs, passes. Every other MCP tool call is checked whole, so one that
  looks up a real key by its value is denied too.
- **secret-allow-guard** checks at session start, so a rule approved during
  a session is caught by the next one. It matches known key formats and
  secrets typed after a flag or variable name, so a bare password with no
  marker next to it is missed; a value written as `$VAR` or `${VAR}` passes.
  An `env` or MCP `env`/`headers` entry is read as `NAME=value`, so a
  harmless value under a secret-like name (`TOKEN_FILE=/run/token`,
  `SECRET_NAME=prod/db`, an `AWS_SECRET_ARN`) and a long default
  (`${API_KEY:-unset}`) are flagged, and an opaque token under a plain
  header name (`X-Auth`) is missed. Ignore the
  file in every repo on the machine, including ones cloned later, with
  `git config --global core.excludesfile ~/.gitignore_global` and
  `.claude/settings.local.json` as a line in that file.

## Security

See [SECURITY.md](SECURITY.md) to report a way past a guard.

## License

[MIT](LICENSE)
