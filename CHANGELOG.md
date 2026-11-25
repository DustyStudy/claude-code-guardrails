# Changelog

## 0.9.0 (unreleased)

Works through the bypasses and false positives the 0.8 hardening audit reproduced.
Most guards now deny more, so commands that used to run may be denied; each mod's
line says which.

- Shared parser (aws-guard, secret-read-guard, supply-chain-guard, terraform-guard):
  decodes bash `$'…'` escapes and reads the line both with and without them, marks
  brace sequences, keeps a comma-less brace pair literal, reads `>|` and `&>` as
  redirections, refuses (denies) a `case` inside `$( )`, and can report where a
  substitution stood.
- aws-guard 0.7.0: denies an AWS CLI call whose service or operation the shell fills
  in: a substitution, variable, glob or splat anywhere up to the operation
  (`aws s3 $(echo rb) …`, `aws iam del$()ete-role`, `aws $OPTS …`), an unquoted
  substitution or variable as a global option's value before the operation
  (`aws --profile $P …`; `"$P"` still runs), Organizations or Identity Center filled
  in as a global option's value, and the binary as a container's `--entrypoint`.
  `-WhatIf` no longer allows a cmdlet in a command that holds a here-string.
- secret-allow-guard 0.5.0: a settings file that does not parse as JSON is also
  scanned with its args joined, so a secret after a flag (`"args":["--api-key","…"]`)
  is found. No longer flagged: a port mapping after the word login (`-p 8080:80`),
  `token_type=bearer`, `*_FILE` and `PWD` with a path, `*_ENDPOINT` with an http(s)
  url, and an `Authorization: Bearer <placeholder>` value.
- secret-read-guard 0.5.0: denies a credential variable printed as `${NAME}` or
  through a member call (`$env:GITHUB_TOKEN.ToString()`), a file read by a quoted
  substitution (`echo "$(<.env)"`), `kubectl get Secret` in any case, a credential
  folder reached by a bare `cd` or a chain of more than three `cd` moves, and a
  wildcard that writes no credential name (`cat *`, `cat prod*`) when the folder
  holds a credential file: the shell guard now lists that folder, dot files
  included, and denies a wildcard in a folder of more than 2,000 entries.
  `echo 'export { a, b }'` is no longer read as an environment dump
  (`export {,}`, which bash runs as a bare `export`, still is).
- supply-chain-guard 0.4.0: denies npm's shortened verbs (`npm upd`, `npm exe`,
  `npm creat`); any number of unlisted options before the verb; a URL with a version
  after `@`; a verb or tool the shell fills in (`npm $(echo install) x`,
  `npm $VERB x`, `$(which pip) install x`, `$NPM install x`); a tool run through a
  runner (`npx --no-install npm install x`, `pnpm exec pip install x`,
  `yarn run pip install x`); `pip install --require-hashes -r https://…`;
  `composer require` without an exact version; `go run pkg@latest`; and
  `--package-lock=0`. Also newly denied: a substitution before the verb
  (`npm --prefix "$(pwd)/web" ci`) and `$(which make) install`.
- terraform-guard 0.5.0: denies a help flag given as a flag's value or after find's
  `\;`, `TF_CLI_ARGS` written with escapes, quotes or a shell-filled value, a
  substitution before the subcommand (`terraform -chdir=$(pwd) validate`; quote it),
  and `>|` / `&>` redirections. No longer denies a destroy after an unrelated pipe
  that ended at a `;` or newline.
- tf-lint 0.9.0: denies a secret key assigned through an index or a call
  (`os.environ[...]`, `props.put(...)`) or under a heredoc or block scalar, and a
  secret in a command that writes with `sed -i`, `perl -i`, `New-Item`, `sc`/`ac`/`ni`,
  `dd of=`, a write or append method call (`WriteAllText`, `open().write`,
  `writeFileSync`) or `git config`. No longer denies lower-case words starting
  `asia`/`akia` or Slack bot/user placeholders with no digit after the dash, no
  longer warns on `dynamic "egress"` or `egress = true`, and no longer cuts a line
  at a `#` or `//` inside a double-quoted string.
- Development: tests run on Claude Code 2.1.325 (was 2.1.322), the stable release
  the managed-settings baseline's minimum (2.1.324) accepts.

## 0.8.0 (2026-11-21)

- tf-lint 0.8.0: flags more non-human-identity risks. In Terraform: a
  long-lived `google_service_account_key`, `azuread_application_password` or
  `azuread_service_principal_password`, and a policy that grants every action
  (`Action "*"`) or all of `iam:*` or `sts:*`. In GitHub Actions workflows: a
  stored Azure or Google credential (`AZURE_CLIENT_SECRET`, `credentials_json`
  or `creds` from `secrets`).

- Removed the jev-guard, model-guard, output-trimmer, cleanup-check, tf-plan-summary
  and merged-branch-guard mods. Jev and model choice are one person's policy, not
  the organization baseline, and the other four only remind, display or trim
  output. Their entries below stay as history; they remain in the 0.7.0 release.

- Hardening pass after a security audit of every mod. The shared shell parser
  (aws-guard, secret-read-guard, supply-chain-guard, terraform-guard) reads each
  line as bash, PowerShell and cmd, unescapes words the way the shell does, cuts
  comments and heredocs before quotes, and throws on input over 64 KB or deep
  nesting, so the guard denies what it cannot read. A substitution among a
  checked command's arguments is marked and denied where it could change the call.
- aws-guard 0.6.0: reads the operation after abbreviated global options, calls
  hidden behind docker, uv, poetry, saml2aws, ssh, kubectl and python flags,
  escaped operation and cmdlet names, PowerShell assignments, upper-case static
  key names, and cmdlet switches after quoted, parenthesised, here-string or
  continued arguments.
- secret-read-guard 0.4.0: follows cd, drive-relative, escaped and backticked
  paths, heredoc bodies and here-strings; reads wildcards and `[sets]` against
  credential names; adds the Claude, Codex, Terraform and AppData folders,
  credential variables named in interpreter code, more printers, senders and
  copiers; reads a long command in linear time.
- terraform-guard 0.4.0: denies terraform.cmd/.bat, tofu and terragrunt Windows
  names, calls through builtin, noglob, npx, bunx, pnpm, yarn and uvx, and an
  apply or destroy with a `$( )`, backtick or `( )` among its arguments; reads a
  quoted TF_CLI_ARGS value whole; the fed-destroy check is linear.
- supply-chain-guard 0.3.0: reads versioned pip and python names, corepack,
  npx, bunx, uvx and pipx, every npm install spelling, update, exec, dlx and init,
  uv tool, run --with and pip sync, option values, substituted or xargs-fed
  packages, lockfile-off installs, and cargo, gem, go and composer installs;
  --require-hashes and -e exempt only where pip honours them.
- secret-allow-guard 0.4.0: bounds every matcher so a hostile settings or
  .mcp.json file cannot hang session start, scans MCP args, url and command, reads
  name-based secrets from a file with a BOM, trailing comma or other broken JSON,
  and adds Slack app tokens and webhooks, Azure storage keys and PGP private key
  blocks.
- tf-lint: closes secret-deny bypasses (escaped quotes, `aws-secret-access-key`,
  `aws configure set`, XML and dotted spellings, a key after `_`, EXAMPLE added to
  a real value, doubly nested JSON in MCP calls), flags ingress rules named for
  egress, stored keys in `run:` steps, block scalars and
  `.github/actions/**/action.yml`, `api_key` variables, OIDC trusts by reference
  without `sub` or `aud`, a `*` aud and `Action "*:*"`, reports a failed read
  instead of dropping warnings, and reads 100 KB inputs in linear time.

## 0.7.0 (2026-11-21)

- examples/managed-settings.json: locks on secret-read-guard; the Read deny
  list now covers the Azure and Google Cloud CLI token caches, the kube,
  docker, git, npm, PyPI, Vault and Terraform credential files, Claude's and
  Codex's sign-ins and private-key formats (the AWS SSO and CLI caches and
  gh's sign-in stay readable so `aws` and `gh` run sandboxed on short-lived
  credentials); `sandbox.credentials.envVars` removes static keys and token
  variables from sandboxed commands; `allowManagedMcpServersOnly` with an empty `allowedMcpServers`
  loads only MCP servers the file lists; `forceLoginMethod` and
  `forceLoginOrgUUID` require a claude.ai sign-in to your organization.
- secret-read-guard 0.3.1: a quoted heredoc that only hands text to `cat`,
  `tee` or `git commit`/`tag` (`cat > notes.md <<'EOF'`) is no longer read as
  commands, so notes that mention `env |` or `.env` are not denied. Only when
  it is the whole command; unquoted heredocs, heredocs fed to any other
  program, anything after the end line, a carriage return, and the terminal
  tool are read as before.
- output-trimmer: documents that it trims only a command that succeeds. A
  failed call is not trimmed, and the README says why.
- supply-chain-guard 0.2.0: also checks `Monitor` and the desktop app's
  terminal tool, as the other command guards do, so an unpinned install run
  through either is denied.
- tf-lint 0.7.0: also checks `Monitor`, so a secret written to a file from a
  Monitor command is denied.
- Removed taint-guard. It was not loaded in the maintainer's own setup, and
  Claude Code's auto mode now judges outbound and publishing commands itself,
  with a server-side check on suspicious tool results. Nothing replaces its
  `/taint-clear` lock; for a session that reads untrusted content, use the
  sandbox network allowlist in `examples/managed-settings.json`. The example
  no longer enables it, and the `TAINT_GUARD_*` settings are gone.
- examples/managed-settings.json: the force-push deny rules are now whole
  words for Bash and PowerShell, so `git push origin main --force` is denied
  and `--force-with-lease` still runs; `Edit(~/.claude/**)` is replaced by
  the config and code folders it was meant to protect, so Claude can still
  write its memory and plans.
- Removed destructive-guard, self-guard, commit-identity-guard,
  gh-ci-status and aws-context: Claude Code now does their job. Auto mode
  blocks force push, `reset --hard`, `clean -fd` and `terraform destroy`, and
  Claude Code itself refuses `rm -rf` of critical paths; protected paths and
  `Edit(...)` deny rules cover `~/.claude`; the `attribution` setting drops
  the Claude trailers; the desktop app shows pull request checks and offers
  Auto-fix; a status line script can show the AWS profile and region.
  `examples/managed-settings.json` now carries `permissions.deny` rules for
  force push, `reset --hard`, `clean -f` and `~/.claude` in place of the
  mods, and no longer sets `COMMIT_GUARD_OWNERS`. Remove the five mods from
  `enabledPlugins` and `CLAUDE_CODE_PLUGIN_DIRS`.
- jev-guard 0.4.0: no longer reads the last region aws-context saw; it takes
  the region from the command's profile, `AWS_REGION`, `AWS_DEFAULT_REGION`
  and the AWS config file, as before.

- tf-lint 0.6.0: flags non-human-identity risks. In Terraform: a static
  `aws_iam_access_key` or an `aws_iam_user_login_profile` (also in
  `.tf.json`); a GitHub OIDC trust policy (`jsonencode`, heredoc JSON or
  `aws_iam_policy_document`) with no `:sub` condition, a `sub` of `*`,
  `repo:*` or `repo:<org>/*`, or no `:aud` condition; a `*` principal with
  no condition; and a variable or output named for a secret, password,
  token, private key or access key that is not `sensitive = true`, or such
  a variable with a literal default. In `.github/workflows/*.yml` it flags
  `aws-access-key-id`, `aws-secret-access-key`, and `AWS_ACCESS_KEY_ID` or
  `AWS_SECRET_ACCESS_KEY` set from `secrets.`, pointing to `role-to-assume`
  with `id-token: write`. The secret deny now also covers shell commands
  that write a file and the arguments of MCP tool calls.
- aws-guard 0.5.0: also denies, by AWS CLI and by cmdlet, changes to
  non-human identities and static keys: `iam upload-`/`update-ssh-public-key`
  and `-signing-certificate` (`Publish-`/`Update-IAMSSHPublicKey`,
  `-IAMSigningCertificate`); every `sso-admin` call but `describe-`,
  `list-` and `get-` (any `SSOADMN` cmdlet but Get); `identitystore`
  create, update and delete (`New-`/`Update-`/`Remove-IDSUser`, `Group`,
  `GroupMembership`); `rolesanywhere` create, update and enable of trust
  anchors and profiles (`IAMRA` cmdlets); `aws configure set` of
  `aws_access_key_id`, `aws_secret_access_key` or `aws_session_token`
  (also `profile.x.`), `aws configure import`, `Set-AWSCredential -StoreAs`
  with a key or credential, and `Initialize-AWSDefaultConfiguration` with
  one. Reads, `aws configure set region` and switching profiles run.
- secret-allow-guard 0.3.0: besides permission rules, also checks `env`
  values and MCP servers' `env` and `headers` values for literal secrets,
  with the same matchers, in the settings files it already read, in
  `~/.claude.json` (your MCP servers and every project's) and in the
  project's `.mcp.json`. A value written as `$VAR` or `${VAR}` passes. The
  warning still names only the file and the count.
- usage-band removed: Claude Code now shows your plan usage itself, so the
  band above the prompt and its Codex warning after a Codex run are gone.
  Drop `usage-band` from any `enabledPlugins` or `CLAUDE_CODE_PLUGIN_DIRS`
  that still names it.
- cleanup-check 0.4.0: no longer counts or prunes old plugin versions in
  `~/.claude/plugins/cache`, and `CLEANUP_CHECK_PRUNE_CACHE` is gone.
  Claude Code now deletes an old version itself 14 days after an update
  or uninstall replaces it. The other leftovers it reports are unchanged.
- secret-read-guard 0.3.0: closes access-key and non-human-identity gaps.
  Denies sending a credential file out (`gh gist create .env`, `gh issue
  comment --body-file`, `gh api -F x=@.env`, `curl -F f=@.env`, `curl -T`,
  `wget --post-file`, `Invoke-WebRequest -InFile`, `aws s3 cp .env s3://…`,
  `aws … file://.env`, `git add .env`) and printing a remote state file
  (`aws s3 cp s3://b/terraform.tfstate -`). More printers: `aws sso
  get-role-credentials`, `sso-oidc create-token`, `sts assume-root`, `ecr
  get-login-password` (it still runs piped to `docker login
  --password-stdin`), `codeartifact get-authorization-token`, `eks
  get-token`, `rds generate-db-auth-token`, `secretsmanager
  get-secret-value`, `ssm get-parameter --with-decryption`, `kms decrypt`,
  their AWS Tools for PowerShell cmdlets, `terraform output -json|-raw`,
  `terraform show -json`, `aws-vault export`, `op read`, `op item get
  --reveal`, `vault read|kv get|print token`, `sops -d` and `kubectl get
  secret -o yaml|json|jsonpath`. Printing one variable named for a
  credential (`echo $GITHUB_TOKEN`, `$env:AWS_SECRET_ACCESS_KEY`, `printenv
  NPM_TOKEN`, `[Environment]::GetEnvironmentVariable('X_TOKEN')`) is denied,
  but passing it to a program still runs (`curl -H "Authorization: Bearer
  $GITHUB_TOKEN"`, `echo $GITHUB_TOKEN | gh auth login --with-token`).
  `aws-vault exec p -- env`, `op run -- env`, `doppler run -- printenv` and
  `timeout 5 env` count as dumping the environment. New credential files:
  service-account JSON keys, `~/.aws/login/cache`, every file under
  `~/.kube`, `~/.config/git/credentials`, Az PowerShell's
  `AzureRmContext.json`, `TokenCache.dat` and `.IdentityService/msal.cache*`,
  and `~/.claude.json`. A project's `.mcp.json` stays readable. A recursive
  search from above the home folder (`rg x C:\Users`, `grep -r x /`, the
  Grep tool on `C:\`) is denied, and `robocopy`, `mklink`, `New-Item
  -ItemType SymbolicLink`, `Compress-Archive` and `tar -c` count as copies.
- model-guard 0.4.0: with `MODEL_GUARD_FALLBACK_MODEL` set (and optionally
  `MODEL_GUARD_FALLBACK_EFFORT`), a subagent whose run on the pinned model
  ends on a usage or rate-limit error flags that model out until its reset,
  read from the error (`resets 4pm (America/Chicago)`, an epoch or an ISO
  time), else the account's full rate-limit window, else five hours. Until
  then each subagent request on the pinned model goes to the fallback model
  and effort, then moves back on its own; one notice marks each switch.
  Forks and the main loop are untouched; unset, nothing changes.
- merged-branch-guard 0.1.0 (new): denies `git push` that continues a
  branch whose pull request is already merged, has no open one, and is gone
  from the remote. Such a push recreates the branch GitHub deleted on merge
  and leaves the new commits outside any PR. Long-lived branches still on
  the remote and new branches reusing an old name run.
  The deny names the merged PR and gives the commands to cut a new branch
  from the default branch and cherry-pick the commits made after the merge.
  Pushes with an open PR or no PR, to the default branch, of tags and of
  deletes run. When `gh` is missing, signed out, offline or slow (5-second
  timeout), the push runs with a note.
- README: the mod count reads nineteen; it had not counted
  supply-chain-guard.
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
