# Changelog

## Unreleased

- secret-read-guard 0.2.0: closes ways around it found in a red-team pass.
  `Monitor` and the desktop terminal tool are now read like Bash. grep
  flags that let the file pass for the pattern are fixed (`grep -a KEY
  .env`, `grep KEY -E .env`, `grep -eKEY .env`, `grep -f pats .env`, `rg -rl
  KEY .env`, `jq -c . terraform.tfstate`, `sed -nep .env`). Also denied:
  `cat 0< .env` and `cat <>.env`; `cat $(ls .env)` and `gc (ls *.tfvars)`;
  `cat .e\nv` and `ca\t .env` in Bash; `cp terraform.tfstate{,.json}`,
  `install`, `rsync`, `scp` and `xcopy` out of a credential file; `rev`,
  `paste`, `fold`, `column`, `iconv`, `zcat`, `perl -pe` and `ruby -pe`;
  `OpenRead`, `StreamReader`, `createReadStream` and `File.read`; the whole
  environment from an interpreter (`python -c "print(os.environ)"`, `node
  -p process.env`, `jq -n env`, awk `ENVIRON`, ruby `ENV`, perl `%ENV`) and
  `/proc/<pid>/environ`; `gh auth git-credential`, `aws sts
  get-session-token` and `assume-role`, `docker-credential-* get`, `gpg
  --export-secret-keys`. New guarded names: `.envrc`, `*.env`,
  `.env-<name>`, any file in `~/.ssh` but `config`, `known_hosts`,
  `authorized_keys` and `*.pub`, `~/.terraform.d/credentials.tfrc.json`,
  `.terraformrc` and `.vault-token`. One variable by name still runs.
- taint-guard 0.7.0: closes ways around the lock found in a red-team pass.
  Once tainted it now also denies: sends that are no program's argument
  (bash `/dev/tcp`, .NET `Net.WebClient`/`Sockets`/`Dns`, a
  `\\host.example\share` or `//host.example/share` path, a `*_PROXY`
  variable, a URL handed to `start`, `Start-Process`, `explorer` or
  `xdg-open`); git made to run a program (`-c alias.x=!...`,
  `core.sshCommand`, a pager or editor other than `cat`/`true`/`less`,
  `GIT_SSH_COMMAND`, `--upload-pack`) or to push by another name
  (`send-pack`, `subtree push`, `lfs push`); gh reads sent to another host
  (`-R evil.example/o/r`, a URL off github.com, `GH_HOST` or `GH_REPO` on
  any call); `AWS_ENDPOINT_URL` and `--endpoint-url` abbreviated to `--e`;
  `terraform init -from-module` or with a remote address, `refresh`,
  `workspace new|delete`, `terragrunt run-all apply`; `kubectl` and `helm`
  writes; `npm pub` (npm takes a command by prefix), `python -m twine`,
  `poetry publish`, `dotnet nuget push`, `docker buildx --output
  type=registry`; a URL handed to `cargo`, `gem`, `deno`, `node`, `kubectl`
  and other runners; `openssl s_client`, `aria2c`, `http`, `plink`/`pscp`,
  `rclone`, `whois` and more network tools; `claude` and `codex` (a new
  session is not tainted); `CronCreate` and `RemoteTrigger`; and MCP
  resource reads (`ReadMcpResourceTool`), which are now judged as a call to
  their server and taint like one. A WebFetch URL is denied when encoded
  data sits anywhere in a path part (`TOKEN~`, `a;TOKEN`), not only when it
  is the whole part. `aria2c`, `Start-BitsTransfer`, `certutil -urlcache`
  and .NET downloads taint like `curl`. `aws ... --engine` is no longer
  taken for `--endpoint-url`.
- commit-identity-guard 0.4.1: closes ways around it found in a red-team
  pass. A commit is now seen when written `GIT commit`, `git c""ommit`,
  across a line continuation, or after `--work-tree <dir>`; a PR when gh's
  options come before `pr`, and `gh pr merge` is checked too (body, `-F`,
  `--author-email`). A trailer is found when written `--trailer
  "Co-Authored-By=..."` or with quotes inside its words, in a file given as
  `-aF` or `--fil`, and on an amend with no new message (`--am`, no
  `--no-edit`) or a `-c <commit>` reuse. An address is read from `-c
  USER.EMAIL=`, a key split by quotes, a value with no `@`, `$env:VAR =
  'x'`, `git config user.email x &&`, `--auth=`, and an `--author` that is
  only a pattern is denied. Identity variables count as an override only on
  git's own command, not when printed or held in another variable. Config
  the guard cannot read (`GIT_CONFIG_*`, `HOME`, `EMAIL`, `--config-env`,
  `include.path`) is denied. `-Rowner/repo`, `-R github.com/owner/repo` and
  `GH_REPO=` name the repo.
- aws-guard 0.4.2: denies ways around the list found in a red-team pass. An
  abbreviated or unknown global option whose value stood where the service
  was expected (`aws --prof security iam delete-role`); `--dry-run` taken
  back by `--no-dry-run`; `secretsmanager delete-secret` with
  `--cli-input-json`, which can carry the forced delete; `Remove-SECSecret
  -DeleteWithNoRecovery`; and the pip AWS CLI called as `aws.cmd` or
  `python -m awscli`.
- terraform-guard 0.3.1: denies ways around `-auto-approve` found in a
  red-team pass. Terragrunt destroying every unit, where it approves by
  itself (`run-all destroy`, `run --all destroy`, `destroy --all`,
  `graph destroy`, `destroy-all`; `--no-auto-approve` still runs);
  `apply-all`; an approval fed to `destroy` (`echo yes | terraform destroy`,
  `terraform destroy <<< yes`); and `TF_CLI_ARGS` set with `+=` or
  `SetEnvironmentVariable`. A flag's value no longer passes for a plan file
  or a subcommand: any flag written without `=` takes the next word unless
  it is known to stand alone, so `terragrunt run-all apply
  --terragrunt-working-dir live`, `tofu apply -exclude x` and `terragrunt
  --working-dir modules apply -auto-approve` are denied.
- destructive-guard 0.6.1: closes spellings found in a red-team pass. git's
  shortened long options (`reset --har`, `push --mirr`, `clean --forc`,
  `switch --discard`), `git --config-env k=V reset --hard`, `git -c
  clean.requireForce=false clean`, and `restore ./*` or `restore ..` are
  denied like the plain forms. So are `rm --r --f`, `rm -rf ~name`,
  `rd /s/q`, and a relative delete after `Push-Location`. SQL is also read
  without its comments (`DROP/**/TABLE`, `DELETE FROM t -- WHERE`), and
  `DROP MATERIALIZED VIEW`, `OWNED`, `KEYSPACE` and `PARTITION`,
  `deleteMany({})`, `dropdb`, and the `pgcli`, `mycli`, `litecli`, `usql`
  and `cqlsh` clients count. Disk formats add `format D:`, `mke2fs`,
  `mkswap`, `wipefs`, `dd of=\\.\PhysicalDrive0` and a redirection into
  `/dev/sd*`; `dd of=/dev/stdout` now runs.
- self-guard 0.3.1: closes spellings found in a red-team pass. A guarded
  path is now found inside a quoted command line or code (`bash -c "..."`,
  `python -c "open('...')"`), after an option's `=` (`--output=path`),
  through `$USERPROFILE` or `%HOMEDRIVE%%HOMEPATH%`, a wildcard
  (`~/.claud*/CLAUDE.md`, `.claude/settings*.json`), braces
  (`settings{,.local}.json`), a backslash bash drops (`~/.cl\aude`), and as
  a relative path after a `cd` (`cd ~ && rm .claude.json`). `>& file`, a
  redirection behind an escaped quote, `git -c key=program status`, and
  `cp -r other/.claude ~` are changes. Write and Edit resolve `\Users\me`
  and `C:..\x` as Windows does. A commit or PR message (`-m`, `--body`,
  `--title`) may still name a guarded path. Reading next to `true`, `test`,
  `[ ... ]`, `printf` or PowerShell's `select` and `where` is no longer
  taken for a change (`cat .claude/settings.local.json 2>/dev/null || true`).

- secret-allow-guard 0.2.0: also flags `curl -u user:pass`, an
  `Authorization` header of any scheme (`Basic`, `token`), `docker login -p`,
  `redis-cli -a`, `mysqladmin -p` and the other `mysql*` and `mariadb*`
  clients, a value after `--token` or `--api-key` and a space, `aws configure
  set aws_secret_access_key`, `DB_PASS=` and `passphrase=`, a password with a
  `$` inside it, a Stripe live key, a Google API key and a JWT. It reads the
  user settings in `CLAUDE_CONFIG_DIR` too.
- tf-lint 0.5.0: the secret deny also matches the AWS secret key under the
  provider's `secret_key` and the API's `SecretAccessKey`. The Terraform
  checks now read a rule resource that holds a nested block (an
  `aws_security_group_rule` with `lifecycle` was skipped), blocks with
  unquoted labels (`resource aws_kms_key logs {`, `provider aws {`),
  `*.tofu` files and ARNs in any `aws-*` partition, and ignore a setting
  inside a `/* */` comment that starts its line.
- jev-guard 0.3.0: also checks the script run without its extension
  (`tools\jev`) and a direct call to `api.typesafe.ai` (`curl`,
  `Invoke-RestMethod`). A name split by quotes or a PowerShell backtick
  (`prod.tf''vars`) is read whole. More secret files count (`prod.env`,
  `.envrc`, `cat <.env`, anything under `.aws`, `.ssh`, `.kube`, `.docker`,
  `.azure` or `gcloud`, `.git-credentials`, `.pypirc`, `*.ppk`, `*.jks`),
  as do the key formats tf-lint denies (GitLab, fine-grained GitHub, npm,
  Anthropic, OpenAI, Stripe live, Google, Supabase), a secret read by
  `env:NAME`, `GetEnvironmentVariable` or `printenv NAME`, the whole
  environment piped on, and the output of `gh auth token`, `aws
  secretsmanager get-secret-value`, `aws configure get`, `terraform output`,
  `show` and `state pull`. A profile named for GovCloud counts as GovCloud.
- model-guard 0.3.0: more Codex runs are checked: the interactive CLI given a
  prompt (`codex "fix it"`), the CLI started by a package runner (`npx
  @openai/codex exec`, `npm exec`, `pnpm dlx`, `bunx`), and the companion run
  by `bun` or `deno`. `-c review_model=x` and a padded `-c " model = x"` count
  as the model, and a `--model` that the companion reads as the value of
  `--cwd`, `--prompt-file`, `--base` or `--scope` no longer counts as the
  flag. With `MODEL_GUARD_SUBAGENT_MODEL` set, a `claude` run from the shell
  that names another model (`--model`, or a model in its `--agents` or
  `--settings` JSON) is denied, and a session started with
  `mcp__ccd_session__start_session` inherits this session's model whatever
  model the call names.
- self-guard 0.3.0: a path built through a variable is now filled in before
  the command is read. `$d="$HOME\.claude"; Copy-Item x "$d\CLAUDE.md"`,
  `d=~/.claude; rm $d/settings.json`, `export D=...` and `Join-Path $HOME
  ".claude"` are denied like the literal path; reading through a variable
  still runs. Set-Variable and values from other commands are still not
  followed.
- `examples/managed-settings.json`: a managed-settings baseline for a
  company rollout (mods locked on, marketplace pinned to a commit, bypass
  mode off, managed-only hooks and permission rules, credential-file deny
  rules, sandbox network allowlist, OpenTelemetry export, retention). The
  README's "A managed-settings baseline" explains each block and what the
  telemetry does not record. `npm test` checks the file.
- secret-read-guard (new): denies reading a credential file into the
  conversation by `Read`, `Grep`, or a shell command that prints it or
  copies it out (`.env`, AWS, SSH and cloud CLI credentials, private keys,
  Terraform state and `*.tfvars`, `.npmrc`, `.netrc`, kube and Docker
  config); dumping the whole environment; and commands that print a stored
  credential (`aws configure get` of a secret, `aws configure
  export-credentials`, `gh auth token`, `git credential fill`, `terraform
  state pull`). `.env.example`, `*.pub`, existence checks and programs that
  use a file without printing it still run. `SECRET_READ_ALLOW` exempts
  globs. The mod count is seventeen.
- tf-lint 0.4.0: the secret deny on edits also covers GitLab, npm,
  Anthropic, OpenAI, Stripe live, Google API, Azure storage and Supabase
  keys, Slack `xoxs-` tokens and webhooks, and PGP and any other
  `PRIVATE KEY` block. A value holding `EXAMPLE` still passes.
- aws-guard: also denies, by AWS CLI and by cmdlet, calls that turn off
  logging or detection (CloudTrail, GuardDuty, Config, Security Hub,
  `logs delete-log-group`/`put-retention-policy`, `ec2 delete-flow-logs`),
  open S3 to the public (public access block, bucket policy, bucket ACL,
  bucket encryption), change IAM access or identities (access keys, login
  profiles, attach/detach/put policy, trust policy, policy versions, group
  membership, MFA, password policy, SAML and OIDC providers, any `delete-*`),
  weaken KMS keys (`disable-key`, `put-key-policy`, grants), or destroy data
  (`s3 rb`, `s3 rm --recursive`, `s3api delete-bucket`, RDS, DynamoDB, EFS,
  `ec2 terminate-instances`, `secretsmanager delete-secret` without a
  recovery window, `backup delete-*`, `route53 delete-hosted-zone`).
  `--dry-run` on EC2 and `--dryrun` on `s3` pass.
- taint-guard: in a tainted session, denies git calls that name a URL or
  `user@host:` (`clone`, `fetch`, `pull`, `ls-remote`, `remote`,
  `submodule`, `config`, `archive`); installs from a URL or with the index,
  registry or proxy pointed elsewhere (`pip`, `uv`, `npm`, `pnpm`, `yarn`,
  `bun`, `npx`, `python`, `PIP_INDEX_URL`, `GOPROXY`); `docker`/`podman`
  pulls and runs and `go get`/`install`/`run` of a host-qualified image or
  module; and DNS and ping tools (`nslookup`, `dig`, `host`, `ping`,
  `Resolve-DnsName`, `Test-NetConnection`, `tracert`, `traceroute`). Plain
  `git fetch`/`pull` against configured remotes still run. `gh` views,
  diffs, `gh run view --log` and `gh api` now taint the session like `curl`,
  since they return text third parties write.
- The repository is a plugin marketplace (`.claude-plugin/marketplace.json`),
  so an organization can install the mods from a release tag and lock them
  on through managed settings. The README's "Deploying across an
  organization" shows how.
- README: a versioning rule for mods and releases; the stated minimum Claude
  Code release now follows the one pinned in `package.json`; the mod count
  is sixteen.
- jev-guard: its `plugin.json` carries author and license like the others.
- CI: `npm test` fails when a mod's `plugin.json` lacks name, version,
  description, author or license, or the marketplace does not list every
  mod. The test job's runner blocks network egress except GitHub and the
  npm registry.
- cleanup-check: at session start, counts plugin versions that updates left
  in `~/.claude/plugins/cache` and shows the count in a toast. With
  `CLEANUP_CHECK_PRUNE_CACHE=1` it deletes them, keeping each version
  `installed_plugins.json` lists and any plugin updated in the last day.
  Plugins it cannot place are left alone, including an install path deeper
  than a version folder. Paths compare case-insensitively only on Windows
  drive paths.
- cleanup-check: in Desktop, a Clean up button beside what is left drafts the
  ask into the prompt box (merged branches with `git branch -d`, ask before
  any unmerged branch or secret file); nothing runs until you send it.
- taint-guard: `gh pr merge` runs in a tainted session. A body, subject or
  author flag, `--admin`, a URL off github.com, or `GH_HOST` still deny it.
- taint-guard: `TAINT_GUARD_BROWSER_HOSTS` names sites where the browser
  tools work without tainting the session. The guard reads tab addresses from
  the browser's own tab list before and after each call, never from page
  text. In a tainted session one step on a listed tab still runs; page
  scripts and multi-step batches do not. Any other site, or a tab whose
  address the list does not confirm, taints or is denied as before.
- secret-allow-guard (new): at session start, warns when a Claude settings
  file holds a permission rule with a literal secret, and when the project's
  `.claude/settings.local.json` is tracked by git or not git-ignored.
- model-guard: `codex queue`, `resume` and `fork` count as CLI runs, since
  each runs a model; before, only `exec`, `e` and `review` did.
- shell.ts (all six guards): the rest of a heredoc's opening line is read as
  a command again. `cat <<EOF | terraform apply -auto-approve` got past
  terraform-guard, and the same held for every guard that shares the parser.
  Also: `<<<` is a here-string, not a heredoc that hid the lines after it; an
  unquoted heredoc's `$( )` and backticks count as calls; and a heredoc piped
  to a shell after its end (`cat <<EOF |` ... `EOF` `sh`) is read as its script.
- self-guard: a heredoc fed only to a reader, `git commit`/`tag` or the Codex
  companion is data, so a commit message or Codex brief that names
  `~/.claude` runs. One fed to a shell, `node` or any other program is still
  searched. `NODE_OPTIONS` in the session's environment, not only in the
  command, stops the companion counting as a reader.
- model-guard: the `codex` CLI has no `--effort`, so no CLI run could pass the
  guard and start. It now takes `-c model_reasoning_effort=x` as the effort,
  reads `-c model=x`, `-mx` and `-m=x` as the model (each must match), and
  denies a profile, `--oss` or another provider.
- model-guard: `node -e`, `-p` or `-` (stdin) given the companion's path as
  an argument is no longer taken for a Codex run. Found in a Codex review.
- model-guard: the Codex companion's `review` and `adversarial-review` need
  only the flags other than `--effort`, which they do not take. Before,
  `/codex:review` could not run at all and `adversarial-review` read
  `--effort medium` as its focus text.
- model-guard: a later `-m`, `-model` or `--m=` that switches the model, or
  `-effort` the effort, now counts, as the companion reads them; and a Node
  option with a value before the script (`--require node:fs`) no longer hides
  a companion run. Found in a Codex review.
- self-guard: new mod. Denies edits, shell writes and `claude plugin`/`mcp`/`config`
  changes to Claude Code's own config and code (`~/.claude`, `~/.claude.json`,
  the mod folders, project `.claude` settings), so an agent cannot switch off
  its own guardrails or plant a hook. Add it to `CLAUDE_CODE_PLUGIN_DIRS`.
- self-guard: `node <codex-companion.mjs>` from the Codex plugin counts as a
  reader, so `/codex:setup` and Codex tasks run from the main session, unless
  another argument names a guarded path, it toggles the review gate, or the
  command mentions `NODE_OPTIONS`. Other plugin scripts are still denied.
  `cut` and `which` count as readers.
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
- terraform-guard, aws-guard, destructive-guard, self-guard,
  commit-identity-guard, jev-guard, model-guard, taint-guard: a command
  given to the `Monitor` tool or to the desktop app's terminal tool
  (`mcp__terminal__run_in_terminal`) is now checked the way a Bash or
  PowerShell command is; before, it ran past every guard. taint-guard also
  treats a `Monitor` WebSocket as an untrusted read, denies one in a
  tainted session, and reads the terminal tool's command even when
  `TAINT_GUARD_TRUSTED` names its server. Other MCP tools that run a
  command are still not read: deny them by name in managed settings.

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
