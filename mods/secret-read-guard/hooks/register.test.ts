import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ENV = { USERPROFILE: 'C:\\Users\\me' }

const world = (on: On, env: Record<string, string> = ENV) => {
  mock.env(on, env)
  on('session.cwd', () => ({ value: 'C:\\repos\\app' }))
}

// Shell commands that would print a credential, run in the project C:\repos\app.
const DENIED = [
  'cat .env',
  'cat .env.production',
  'cat ~/.aws/credentials',
  'cat ~/.ssh/id_rsa',
  'cat /c/Users/me/.ssh/id_ed25519',
  'type C:\\Users\\me\\.aws\\credentials',
  'Get-Content $env:USERPROFILE\\.aws\\credentials',
  'Get-Content -Path:.env',
  'gc "$HOME/.ssh/id_ed25519"',
  'head -n 5 terraform.tfstate',
  'tail prod.tfvars',
  'less deploy/server.key',
  'grep -n PASSWORD .env',
  'grep -e SECRET .env',
  'rg token ~/.npmrc',
  'Select-String -Path .env -Pattern KEY',
  'Select-String KEY .env',
  'sls -Path .env KEY',
  'base64 cert.p12',
  'xxd key.pfx',
  'strings putty.ppk',
  'jq .resources terraform.tfstate.backup',
  'sed -n 1,5p ~/.netrc',
  "awk -F= '{print $2}' .env",
  'cut -d= -f2 .env',
  'diff .env .env.example',
  'dd if=key.pem',
  'cat ~/.pgpass ~/.git-credentials',
  'cat ~/.docker/config.json',
  'cat ~/.kube/config',
  'cat ~/.config/gh/hosts.yml',
  'cat ~/.azure/msal_token_cache.json',
  'cat ~/.config/gcloud/application_default_credentials.json',
  'cat ~/.codex/auth.json',
  'cat ~/.claude/.credentials.json',
  'cat ~/.aws/sso/cache/abc123.json',
  // Through a wrapper, a substitution, a redirection or another spelling of the path.
  'bash -c "cat .env"',
  'sudo cat /etc/ssl/private/site.key',
  'echo "$(cat .env)"',
  'cat < .env',
  'KEY=$(< deploy/key.pem)',
  'cat ./config/../.env',
  'cat "C:/repos/app/.env."',
  'cat .env::$DATA',
  'cat README.md && cat .env.local',
  // Wildcards and folders that take a credential in.
  'cat .env*',
  'cat ~/.ssh/*',
  'cat ~/.ssh/id_*',
  'cat ~/.aws/c*',
  'head *.tfvars',
  'cat *.tf*',
  'cat ~/.aws/{credentials,config}',
  'grep -r aws_secret ~/.aws',
  'rg -i token ~/.ssh',
  // Found in review.
  'cat {.env,.env.example}',
  'cat main.{tf,tfvars}',
  'rg -n password -g "*.{tf,tfvars}"',
  "rg -g '*.tfvars' password",
  'grep --regexp=KEY .env',
  'grep -r aws_secret_access_key ~',
  'grep -r oauth_token ~/.config',
  'cp -r ~/.docker /tmp/d',
  'kubectl config view --raw',
  'cmd /c set AWS',
  'env | cut -f1',
  'sed -n p .env',
  // A copy, move or link out to a name that can be read.
  'cp .env /tmp/env.txt',
  'cp ~/.ssh/id_rsa ./key.txt',
  'Copy-Item .env -Destination notes.txt',
  'Copy-Item -Destination notes.txt -Path .env',
  'mv terraform.tfstate state.json',
  'ln -s ~/.aws/credentials creds.txt',
  'cp -r ~/.ssh /tmp/ssh',
  // A lister that hands the name on, or a variable that carries it.
  'find . -name .env -exec cat {} \\;',
  "find . -name '*.pem' | xargs cat",
  'Get-ChildItem -Recurse -Filter *.tfvars | Get-Content',
  'gci *.pem | % { gc $_ }',
  'ls ~/.ssh/id_* | xargs head -1',
  'for f in .env .env.local; do cat "$f"; done',
  'f=.env; cat $f',
  '$f = ".env"; Get-Content $f',
  // Code handed to an interpreter.
  "[IO.File]::ReadAllText('.env')",
  '[System.IO.File]::ReadAllText("$HOME\\.aws\\credentials")',
  'python -c "print(open(\'.env\').read())"',
  "node -e \"console.log(require('fs').readFileSync('terraform.tfstate','utf8'))\"",
  // The whole environment.
  'env',
  'printenv',
  'set',
  'export -p',
  'env | sort',
  'env | grep -i aws',
  'env > /tmp/e.txt',
  'env 2>&1',
  'FOO=1 env',
  'sudo env',
  'cmd /c set',
  'bash -c env',
  'bash -c "env | sort"',
  'echo "$(printenv)"',
  'Get-ChildItem Env:',
  'gci env:',
  'dir env:\\',
  'ls Env:*',
  'Get-ChildItem Env:AWS*',
  'Get-ChildItem Env: | Format-Table Name,Value',
  '[Environment]::GetEnvironmentVariables()',
  // Stored credentials printed by their own tools.
  'aws configure get aws_secret_access_key',
  'aws --profile prod configure get profile.prod.aws_session_token',
  'aws configure export-credentials --format env',
  'gh auth token',
  'gh auth status --show-token',
  'git credential fill',
  'echo url=https://github.com | git credential-manager get',
  'terraform state pull',
  'terraform -chdir=infra state pull > state.json',
  'tofu state pull',
  'gcloud auth print-access-token',
  'az account get-access-token',
] as const

// Ordinary work: runs.
const ALLOWED = [
  'cat .env.example',
  'cat .env.sample .env.template',
  'cat ~/.ssh/id_rsa.pub',
  'cat ~/.ssh/*.pub',
  'cat ~/.ssh/config',
  'cat ~/.aws/config',
  'cat terraform.tfvars.example',
  'cat main.tf variables.tf',
  'cat docs/environment.md',
  'cat package.json | jq .scripts',
  // Programs that use a file without printing it.
  'terraform apply -var-file=prod.tfvars plan.out',
  'terraform plan -var-file=prod.tfvars -out=plan.out 2>&1 | tail -40',
  'terraform plan -var-file prod.tfvars | grep -v Refreshing',
  'ssh -i ~/.ssh/id_ed25519 host uptime',
  'ssh -i deploy/key.pem ec2-user@10.0.0.1 "cat /var/log/app.log"',
  'git add .env.example && git status',
  'git check-ignore -v .env',
  'aws s3 ls --profile prod',
  'aws configure get region',
  'aws configure list',
  'docker run --env-file .env app',
  'node --env-file=.env server.js',
  'source .env && npm start',
  'openssl x509 -in cert.pem -noout -dates',
  'kubectl --kubeconfig ~/.kube/config get pods',
  // Existence checks and listings.
  'ls -la .env',
  'ls ~/.ssh',
  'Test-Path .env',
  'Test-Path $env:USERPROFILE\\.aws\\credentials',
  'stat terraform.tfstate',
  'wc -l .env',
  "find . -name '*.pem'",
  'Get-ChildItem -Recurse -Filter *.tfvars',
  'ls -la .env; cat README.md',
  // Writing one, or keeping it under a guarded name.
  'cp .env.example .env',
  'cp .env .env.bak',
  'mv terraform.tfstate terraform.tfstate.backup',
  'cat .env.example | sed s/changeme/x/ > .env',
  'echo "FOO=bar" >> .env',
  'rm -f .env.local',
  // The names of the files as search text, not as files.
  'rg "\\.tfvars" docs',
  'grep -rn ".env" README.md',
  'grep -rn TODO *',
  'grep -rn TODO src',
  'Select-String -Pattern "\\.pem" -Path README.md',
  'echo "copy .env.example to .env" | grep env',
  // Found in review.
  "find . -name .env -not -path './node_modules/*' | head",
  "find . -name '*.tfvars' | sort",
  'ls ~/.ssh | grep id_',
  'gci *.tfvars | sort Name',
  'grep -n -A 2 ".env" README.md',
  'rg -C 3 "\\.env" docs',
  'rg -t md ".env"',
  "grep -q '^OPENAI_API_KEY=' .env && echo set",
  'grep -c API_KEY .env',
  "sed -i 's/^DEBUG=.*/DEBUG=true/' .env",
  'kubectl config view',
  'cat src/{a,b}.ts',
  // Names without values.
  "grep -oE '^\\w+ *=' .env",
  "grep -o '^[A-Za-z_][A-Za-z0-9_]*=' prod.tfvars",
  'env | cut -d= -f1',
  'env | wc -l',
  'Get-ChildItem Env: | Select-Object Name',
  'Get-ChildItem Env: | Select-Object -ExpandProperty Name',
  'printenv PATH',
  'echo $env:PATH',
  'Get-ChildItem Env:AWS_PROFILE',
  'env FOO=1 terraform plan',
  'set -euo pipefail',
  'export AWS_PROFILE=dev',
  // Their neighbours on the same tools.
  'gh auth status',
  'git config credential.helper',
  'terraform state list',
  'terraform state show aws_instance.web',
  'gcloud auth list',
  'az account show',
  "git commit -m 'docs: explain why cat .env is denied; set env first'",
  "git commit -F - <<'EOF'\ndocs: never cat .env\nEOF",
  'python -m venv env',
  'npm test',
] as const

for (const tool of ['Bash', 'PowerShell'] as const) {
  for (const [command, isAllowed] of [...DENIED.map(c => [c, false] as const), ...ALLOWED.map(c => [c, true] as const)]) {
    test(`${tool} ${isAllowed ? 'runs' : 'is denied'}: ${command}`, async ($, on) => {
      world(on)
      let hasRun = false

      on('tool.call', { tool: [tool] }, () => {
        hasRun = true

        return { result: { stdout: '', stderr: '', interrupted: false } }
      })

      const ran = await $.tool.call({ tool, command })

      expect(hasRun).toBe(isAllowed)
      expect(/guard failed/.test(JSON.stringify(ran))).toBe(false)
    })
  }
}

const FILES = [
  ['C:\\repos\\app\\.env', false],
  ['.env.local', false],
  ['C:/repos/app/services/api/.env.production', false],
  ['C:\\Users\\me\\.aws\\credentials', false],
  ['C:\\Users\\me\\.aws\\sso\\cache\\abc.json', false],
  ['C:\\Users\\me\\.ssh\\id_ed25519', false],
  ['C:\\Users\\me\\.ssh\\id_work', false],
  ['/c/Users/me/.ssh/id_rsa', false],
  ['deploy/server.pem', false],
  ['certs/tls.key', false],
  ['certs/client.p12', false],
  ['certs/client.pfx', false],
  ['keys/putty.ppk', false],
  ['terraform.tfstate', false],
  ['terraform.tfstate.backup', false],
  ['envs/prod/terraform.tfvars', false],
  ['prod.auto.tfvars.json', false],
  ['C:\\Users\\me\\.npmrc', false],
  ['.npmrc', false],
  ['C:\\Users\\me\\.netrc', false],
  ['C:\\Users\\me\\.pgpass', false],
  ['C:\\Users\\me\\.git-credentials', false],
  ['C:\\Users\\me\\.docker\\config.json', false],
  ['C:\\Users\\me\\.kube\\config', false],
  ['C:\\Users\\me\\.config\\gh\\hosts.yml', false],
  ['C:\\Users\\me\\AppData\\Roaming\\GitHub CLI\\hosts.yml', false],
  ['C:\\Users\\me\\.azure\\msal_token_cache.bin', false],
  ['C:\\Users\\me\\AppData\\Roaming\\gcloud\\credentials.db', false],
  ['C:\\Users\\me\\.codex\\auth.json', false],
  ['C:\\Users\\me\\.claude\\.credentials.json', false],
  ['\\\\?\\C:\\repos\\app\\.env', false],
  ['C:/repos/app/.ENV', false],
  ['C:/repos/app/.env::$DATA', false],
  // The ordinary neighbours.
  ['.env.example', true],
  ['.env.sample', true],
  ['.env.template', true],
  ['C:\\Users\\me\\.ssh\\id_ed25519.pub', true],
  ['C:\\Users\\me\\.ssh\\config', true],
  ['C:\\Users\\me\\.ssh\\known_hosts', true],
  ['C:\\Users\\me\\.aws\\config', true],
  ['terraform.tfvars.example', true],
  ['variables.tf', true],
  ['.terraform.lock.hcl', true],
  ['src/env.ts', true],
  ['docs/.environment.md', true],
  ['src/keyboard.ts', true],
  ['C:\\Users\\me\\.docker\\daemon.json', true],
  ['C:\\Users\\me\\.claude\\settings.json', true],
  ['package.json', true],
] as const

for (const [file_path, isAllowed] of FILES) {
  test(`Read ${isAllowed ? 'runs' : 'is denied'}: ${file_path}`, async ($, on) => {
    world(on)
    let hasRun = false

    on('tool.call', { tool: ['Read'] }, () => {
      hasRun = true

      return { result: {} as never }
    })

    await $.tool.call({ tool: 'Read', file_path })

    expect(hasRun).toBe(isAllowed)
  })
}

const GREPS = [
  [{ pattern: 'KEY', path: '.env' }, false],
  [{ pattern: 'aws_secret', path: 'C:\\Users\\me\\.aws\\credentials' }, false],
  [{ pattern: 'aws_secret', path: 'C:\\Users\\me\\.aws' }, false],
  [{ pattern: 'BEGIN', path: 'C:\\Users\\me\\.ssh' }, false],
  [{ pattern: 'password', glob: '*.tfvars' }, false],
  [{ pattern: 'password', glob: '**/.env' }, false],
  [{ pattern: 'password', glob: '.env*' }, false],
  [{ pattern: 'password', glob: '*.{pem,key}' }, false],
  [{ pattern: 'password', glob: '*.{tf,tfvars}' }, false],
  [{ pattern: 'aws_secret', path: 'C:\\Users\\me', glob: '**/credentials' }, false],
  [{ pattern: 'x', path: 'C:\\Users\\me' }, false],
  [{ pattern: '\\.env', path: 'README.md' }, true],
  [{ pattern: 'tfvars' }, true],
  [{ pattern: 'KEY', path: '.env.example' }, true],
  [{ pattern: 'variable', glob: '*.tf' }, true],
  [{ pattern: 'TODO', path: 'src', glob: '*.ts' }, true],
] as const

for (const [input, isAllowed] of GREPS) {
  test(`Grep ${isAllowed ? 'runs' : 'is denied'}: ${JSON.stringify(input)}`, async ($, on) => {
    world(on)
    let hasRun = false

    on('tool.call', { tool: ['Grep'] }, () => {
      hasRun = true

      return { result: {} as never }
    })

    await $.tool.call({ tool: 'Grep', ...input })

    expect(hasRun).toBe(isAllowed)
  })
}

test('the deny names the file, says why and what to do instead', async ($, on) => {
  world(on)

  const ran = await $.tool.call({ tool: 'Read', file_path: 'C:\\repos\\app\\.env' })

  expect(ran.deny).toMatch(/^secret-read-guard: .*c:\/repos\/app\/\.env .*sent to the API.*Ask the user for the one value.*variable names only/)
})

const EXEMPT = { ...ENV, SECRET_READ_ALLOW: ' *.pem, fixtures/*.key ,~/work/demo/.env, .npmrc' }
const EXEMPTED = [
  ['certs/ca.pem', true],
  ['C:\\repos\\app\\test\\fixtures\\dummy.key', true],
  ['C:\\Users\\me\\work\\demo\\.env', true],
  ['.npmrc', true],
  ['certs/tls.key', false],
  ['.env', false],
  ['C:\\Users\\me\\work\\other\\.env', false],
  ['certs/ca.pem.bak.p12', false],
] as const

for (const [file_path, isAllowed] of EXEMPTED) {
  test(`with SECRET_READ_ALLOW, Read ${isAllowed ? 'runs' : 'is denied'}: ${file_path}`, async ($, on) => {
    world(on, EXEMPT)
    let hasRun = false

    on('tool.call', { tool: ['Read', 'Bash'] }, () => {
      hasRun = true

      return { result: {} as never }
    })

    await $.tool.call({ tool: 'Read', file_path })
    expect(hasRun).toBe(isAllowed)

    hasRun = false
    await $.tool.call({ tool: 'Bash', command: `cat ${file_path.replace(/\\/g, '/')}` })
    expect(hasRun).toBe(isAllowed)
  })
}

for (const call of [
  { tool: 'Read', file_path: 'README.md' },
  { tool: 'Grep', pattern: 'x' },
  { tool: 'Bash', command: 'ls' },
] as const) {
  test(`${call.tool} is denied when the guard itself fails`, async ($, on) => {
    on('session.cwd', () => {
      throw new Error('no cwd')
    })
    let hasRun = false

    on('tool.call', { tool: [call.tool] }, () => {
      hasRun = true

      return { result: {} as never }
    })

    const ran = await $.tool.call(call)

    expect(hasRun).toBe(false)
    expect(ran.deny).toMatch(/secret-read-guard: its guard failed/)
  })
}
