import type { EngineInterface, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Fake values built at run time, so no fixture reads as a real key to a scanner.
const AWS = `AKIA${'X'.repeat(16)}`
const GITHUB = `ghp_${'a1'.repeat(18)}`
const OPENAI = `sk-${'z9'.repeat(12)}`
const AUTH = ['Author', 'ization: Bearer'].join('')
const SLACK_APP = ['xapp', '1', 'A0'.repeat(8)].join('-')
const SLACK_HOOK = `${['hooks', 'slack', 'com'].join('.')}/services/T${'A1'.repeat(4)}/B${'C2'.repeat(4)}/${'d3'.repeat(12)}`
const AZURE = `Account${'Key'}=${'Ab1+'.repeat(21)}Ab==`
const PGP = `-----BEGIN ${'PGP PRIVATE'} KEY BLOCK-----`

const settings = (...allow: string[]) => JSON.stringify({ permissions: { allow } })

// The session's folder and the user's home, both with settings files from `files`; git answers each subcommand with `git`'s exit code.
// `git` 'missing' makes every git run reject, as when git is not installed.
const start = async (
  $: EngineInterface,
  on: On,
  files: Record<string, string>,
  git: Record<string, number> | 'missing' = {},
  env: Record<string, string> = {},
) => {
  mock.env(on, { USERPROFILE: '/home/me', ...env })
  const toasts: string[] = []
  // The host resolves a path its own way on each platform, so a file is matched by its ending.
  const find = (path: string) => Object.keys(files).find(one => path.replace(/\\/g, '/').endsWith(one))
  on('fs.read', (_, e) => {
    const name = find(e.path)
    if (name === undefined) {
      throw new Error('ENOENT')
    }

    return { value: files[name] }
  })
  on('fs.exists', (_, e) => ({ value: find(e.path) !== undefined }))
  const codes = git === 'missing' ? undefined : git
  on('process.run', (_, e) => {
    if (codes === undefined) {
      throw new Error('spawn git ENOENT')
    }

    return { value: { exitCode: codes[e.argv[3]] ?? 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  return toasts.join('\n')
}

const LOCAL = '/repo/.claude/settings.local.json'
const IGNORED = { 'ls-files': 1, 'check-ignore': 0 }

// rule, then whether it reads as a literal secret
const RULES: readonly (readonly [string, boolean])[] = [
  ['Bash(PGPASSWORD=hunter2pw psql -h db.example.com -U app)', true],
  ['Bash(sshpass -p rootpass ssh root@203.0.113.7)', true],
  ['Bash(mysql -u root -pS3cretpw -h db.example.com)', true],
  [`Bash(curl -H "${AUTH} ${'ab'.repeat(10)}" https://api.example.com)`, true],
  [`Bash(aws configure set aws_access_key_id ${AWS})`, true],
  [`Bash(git clone https://${GITHUB}@github.com/o/r)`, true],
  [`Bash(OPENAI_API_KEY=${OPENAI} node run.js)`, true],
  ['Bash(psql postgresql://app:Pa55word@db.example.com/prod)', true],
  ['Bash(./deploy --api-key=abcdef123456)', true],
  ['Bash(sshpass -v -p hunter2 ssh user@203.0.113.7)', true],
  [`Bash(curl -H "${AUTH} ${'s1'.repeat(4)}" https://api.example.com)`, true],
  [`Bash(SUPABASE_SECRET_KEY=sb_secret_${'q'.repeat(24)} node app.js)`, true],
  // Found in red-team review.
  [`Bash(curl -u admin:${'hunter'}2 https://api.example.com)`, true],
  [`Bash(curl -H "${AUTH.replace('Bearer', 'Basic')} ${'dXNlcjpw'.repeat(2)}==" https://api.example.com)`, true],
  ['Bash(docker login -u me -p hunter2 registry.example.com)', true],
  ['Bash(redis-cli -a hunter2 ping)', true],
  ['Bash(mysqladmin -u root -pS3cretpw status)', true],
  [`Bash(aws configure set aws_secret_access_key ${'wJalrXUtnF'.repeat(4)})`, true],
  ['Bash(./deploy --api-key abcdef123456)', true],
  ['Bash(./deploy --token abcdef123456)', true],
  ['Bash(DB_PASS=hunter2pw ./migrate)', true],
  ['Bash(DB_PASSWORD=pa$$word1 ./migrate)', true],
  [`Bash(curl -H "X-Session: ${'eyJ'}${'hbGciOiJIUzI1NiJ9'}.${'eyJ'}${'zdWIiOiIxIn0abc'}.${'c2ln'.repeat(6)}" https://api.example.com)`, true],
  [`Bash(echo ${'sk_live'}_${'aB3d'.repeat(6)})`, true],
  // The formats tf-lint also knows.
  [`Bash(echo ${SLACK_APP})`, true],
  [`Bash(curl -d hi https://${SLACK_HOOK})`, true],
  [`Bash(az storage blob list --connection-string "AccountName=a;${AZURE}")`, true],
  [`Bash(echo "${PGP}")`, true],
  // A secret after a long run of arguments, inside the bounded window.
  [`Bash(docker --config ${'/a'.repeat(60)} login -u me -p hunter2 registry.example.com)`, true],
  [`Bash(curl ${'-H "X-A: b" '.repeat(20)}-u admin:${'hunter'}2 https://api.example.com)`, true],
  ['Bash(DB_PASS_WORD_FOR_THE_APP=hunter2pw ./migrate)', true],
  ['Bash(curl https://hooks.slack.com/services)', false],
  ['Bash(echo AccountKey=$STORAGE_KEY)', false],
  ['Bash(echo "-----BEGIN PGP PUBLIC KEY BLOCK-----")', false],
  ['Bash(./xapp-1-up)', false],
  ['Bash(curl -u $API_USER:$API_PASS https://api.example.com)', false],
  ['Bash(curl -u admin https://api.example.com)', false],
  ['Bash(curl -u admin:*)', false],
  ['Bash(docker login -u me -p $REGISTRY_PASS)', false],
  ['Bash(docker login --password-stdin registry.example.com)', false],
  ['Bash(docker run -p 8080:80 nginx)', false],
  ['Bash(redis-cli -a $REDIS_PASS ping)', false],
  ['Bash(./deploy --token $DEPLOY_TOKEN)', false],
  ['Bash(gh auth login --with-token)', false],
  ['Bash(aws sts get-session-token --serial-number arn:aws:iam::123456789012:mfa/me)', false],
  ['Bash(PGPASSFILE=/home/me/.pgpass psql -h db.example.com)', false],
  ['Bash(./run --bypass=enabled)', false],
  ['Bash(PGPASSWORD=$DB_PASS psql -h db.example.com)', false],
  ['Bash(mysql -p)', false],
  ['Bash(mysql -p:*)', false],
  ['Bash(docker login --password-stdin)', false],
  ['Bash(psql "$DATABASE_URL")', false],
  ['Bash(curl -H "Authorization: Bearer $TOKEN" https://api.example.com)', false],
  ['Bash(npm run:*)', false],
  ['Bash(mysql -u root -p -h db.example.com)', false],
  ['Bash(mysql -e "select 1" && mkdir -p build)', false],
  ['Bash(terraform plan:*)', false],
  ['Bash(gh pr view --json title)', false],
]

for (const [rule, isSecret] of RULES) {
  test(`${isSecret ? 'flags' : 'passes'} ${rule}`, async ($, on) => {
    const toast = await start($, on, { [LOCAL]: settings('Bash(ls)', rule) }, IGNORED)
    expect(/literal secret/.test(toast)).toBe(isSecret)
  })
}

test('never shows the secret itself', async ($, on) => {
  const toast = await start($, on, { [LOCAL]: settings('Bash(sshpass -p rootpass ssh root@203.0.113.7)') }, IGNORED)
  expect(toast.includes('rootpass')).toBe(false)
  expect(toast.includes('1 entry looks like')).toBe(true)
})

test('scans the shared and user settings too', async ($, on) => {
  const toast = await start($, on, {
    '/repo/.claude/settings.json': settings(`Bash(echo ${AWS})`),
    '/home/me/.claude/settings.json': settings(`Bash(echo ${GITHUB})`, `Bash(echo ${OPENAI})`),
  })
  expect(toast.includes('/repo/.claude/settings.json: 1 entry looks')).toBe(true)
  expect(toast.includes('/home/me/.claude/settings.json: 2 entries look')).toBe(true)
})

test('scans the user settings in CLAUDE_CONFIG_DIR', async ($, on) => {
  const toast = await start($, on, { '/cfg/settings.json': settings(`Bash(echo ${AWS})`) }, {}, { CLAUDE_CONFIG_DIR: '/cfg' })
  expect(toast.includes('/cfg/settings.json: 1 entry looks')).toBe(true)
})

const API_KEY = ['abcdef', '123456'].join('')
const BEARER = `Bearer ${'ab'.repeat(10)}`

test('flags a literal secret in settings env', async ($, on) => {
  const toast = await start($, on, {
    '/repo/.claude/settings.json': JSON.stringify({ env: { GITHUB_TOKEN: GITHUB, AWS_REGION: 'us-gov-west-1' } }),
  })
  expect(toast.includes("/repo/.claude/settings.json: 1 entry looks like a literal secret (permission rules, env, or an MCP server's env, headers, args, url or command)")).toBe(true)
})

test('flags a literal secret in settings MCP env and headers, and counts both', async ($, on) => {
  const toast = await start($, on, {
    '/home/me/.claude/settings.json': JSON.stringify({
      permissions: { allow: [`Bash(echo ${AWS})`] },
      mcpServers: { api: { command: 'npx', env: { API_KEY }, headers: { Authorization: BEARER } } },
    }),
  })
  expect(toast.includes('/home/me/.claude/settings.json: 3 entries look')).toBe(true)
})

test('flags MCP secrets in ~/.claude.json, top level and per project', async ($, on) => {
  const toast = await start($, on, {
    '/home/me/.claude.json': JSON.stringify({
      mcpServers: { a: { command: 'npx', env: { OPENAI_API_KEY: OPENAI } } },
      projects: { '/repo': { mcpServers: { b: { type: 'http', url: 'https://mcp.example.com', headers: { 'X-API-Key': API_KEY } } } } },
    }),
  })
  expect(toast.includes('/home/me/.claude.json: 2 entries look')).toBe(true)
})

test('scans .claude.json in CLAUDE_CONFIG_DIR', async ($, on) => {
  const toast = await start($, on, { '/cfg/.claude.json': JSON.stringify({ mcpServers: { a: { env: { GITHUB_TOKEN: GITHUB } } } }) }, {}, { CLAUDE_CONFIG_DIR: '/cfg' })
  expect(toast.includes('/cfg/.claude.json: 1 entry looks')).toBe(true)
})

test('flags MCP secrets in the project .mcp.json', async ($, on) => {
  const toast = await start($, on, {
    '/repo/.mcp.json': JSON.stringify({ mcpServers: { a: { command: 'npx', env: { DB_URL: 'postgresql://app:Pa55word@db.example.com/prod' } } } }),
  })
  expect(toast.includes('/repo/.mcp.json: 1 entry looks')).toBe(true)
})

test('never shows an env or header secret itself', async ($, on) => {
  const toast = await start($, on, {
    '/repo/.mcp.json': JSON.stringify({ mcpServers: { a: { env: { GITHUB_TOKEN: GITHUB }, headers: { 'X-API-Key': API_KEY, Authorization: BEARER } } } }),
  })
  expect(toast.includes('3 entries look')).toBe(true)
  for (const secret of [GITHUB, API_KEY, BEARER, 'ab'.repeat(10)]) {
    expect(toast.includes(secret)).toBe(false)
  }
})

test('passes env and header values that reference a variable', async ($, on) => {
  const server = {
    command: 'npx',
    env: { GITHUB_TOKEN: '${GITHUB_TOKEN}', DB_PASSWORD: '$DB_PASSWORD', API_KEY: '${API_KEY:-}', SLACK_TOKEN: '${SLACK_TOKEN:-x}' },
    headers: { Authorization: 'Bearer ${TOKEN}', 'X-API-Key': '${KEY}' },
  }
  expect(
    await start($, on, {
      '/repo/.claude/settings.json': JSON.stringify({ env: server.env, mcpServers: { a: server } }),
      '/repo/.mcp.json': JSON.stringify({ mcpServers: { a: server } }),
      '/home/me/.claude.json': JSON.stringify({ mcpServers: { a: server }, projects: { '/repo': { mcpServers: { a: server } } } }),
    }),
  ).toBe('')
})

test('passes ordinary env, non-string values and a plain MCP server', async ($, on) => {
  const plain = { mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/repo'] } } }
  expect(
    await start($, on, {
      '/repo/.claude/settings.json': JSON.stringify({
        env: { AWS_REGION: 'us-gov-west-1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000', MAX_THINKING_TOKENS: '8000', SOME_TOKEN: 12345678, API_KEY: true },
        ...plain,
      }),
      '/repo/.mcp.json': JSON.stringify(plain),
      '/home/me/.claude.json': JSON.stringify({ ...plain, projects: { '/repo': plain } }),
    }),
  ).toBe('')
})

test('scans a file that does not parse, whole', async ($, on) => {
  const toast = await start($, on, { [LOCAL]: `{ "permissions": { "allow": ["Bash(echo ${AWS})", ] } }` }, IGNORED)
  expect(/literal secret/.test(toast)).toBe(true)
})

const PASSWORD = ['hunter2', 'hunter2'].join('')
const MCP = '/repo/.mcp.json'

// a file strict JSON rejects, or a name-based secret in one; then whether it is flagged
const BROKEN: readonly (readonly [string, string, boolean])[] = [
  ['a BOM', `﻿{"env":{"DB_PASSWORD":"${PASSWORD}"}}`, true],
  ['a trailing comma', `{"env":{"DB_PASSWORD":"${PASSWORD}",}}`, true],
  ['a BOM and a trailing comma', `﻿{"env":{"MYSQL_PWD":"${PASSWORD}"},}`, true],
  ['a trailing comma and a header', `{"mcpServers":{"a":{"headers":{"X-API-Key":"${API_KEY}"},}}}`, true],
  ['a comment and an env password', `{ // local\n "env": { "DB_PASSWORD": "${PASSWORD}" } }`, true],
  ['a comment and MYSQL_PWD', `{ // local\n "env": {"MYSQL_PWD":"${PASSWORD}"} }`, true],
  ['a cut-off file and a header', `{"mcpServers":{"a":{"headers":{"X-API-Key":"${API_KEY}"`, true],
  ['a BOM and no secret', '﻿{"env":{"AWS_REGION":"us-gov-west-1","DB_PASSWORD":"$DB_PASSWORD"}}', false],
  ['a trailing comma and no secret', '{"env":{"MAX_THINKING_TOKENS":"8000","API_KEY":"${API_KEY}",}}', false],
  ['a comment and no secret', '{ // local\n "env": {"AWS_REGION":"us-gov-west-1","DB_PASSWORD":"$DB_PASSWORD","MAX_THINKING_TOKENS":"8000"} }', false],
]

for (const [name, text, isSecret] of BROKEN) {
  test(`${isSecret ? 'flags' : 'passes'} a file with ${name}`, async ($, on) => {
    const toast = await start($, on, { [MCP]: text })
    expect(toast.includes('/repo/.mcp.json: 1 entry looks')).toBe(isSecret)
    expect(toast.includes(PASSWORD) || toast.includes(API_KEY)).toBe(false)
  })
}

// an MCP server, then how many of its entries read as a literal secret
const SERVERS: readonly (readonly [string, Record<string, unknown>, number])[] = [
  ['a key after a flag in args', { command: 'npx', args: ['-y', 'server', '--api-key', `${API_KEY}7890`] }, 1],
  ['a token in args', { command: 'npx', args: ['server', GITHUB] }, 1],
  ['NAME=value in args', { command: 'docker', args: ['run', '-e', `DB_PASSWORD=${PASSWORD}`, 'image'] }, 1],
  ['a password in the url', { type: 'http', url: `https://user:${PASSWORD}@mcp.example.com/mcp` }, 1],
  ['a key in the url query', { type: 'http', url: `https://mcp.example.com/mcp?api_key=${API_KEY}` }, 1],
  ['a secret in the command', { command: `PGPASSWORD=${PASSWORD} psql-mcp` }, 1],
  ['secrets in args, url, env and headers', { command: 'npx', args: [OPENAI], url: `https://${SLACK_HOOK}`, env: { API_KEY }, headers: { Authorization: BEARER } }, 4],
  ['variables in args and url', { command: 'npx', args: ['--api-key', '${API_KEY}', '--token', '$TOKEN'], url: 'https://${USER}:${PASS}@mcp.example.com/mcp?api_key=${KEY}' }, 0],
  ['ordinary args and url', { command: 'docker', args: ['run', '-p', '8080:80', '--rm', 'mcp/server', '--port', '8080', 12, null], url: 'https://mcp.example.com/mcp?mode=read' }, 0],
  ['args, url and command of the wrong type', { command: 7, args: 'npx', url: ['x'] }, 0],
]

for (const [name, server, count] of SERVERS) {
  test(`${count > 0 ? 'flags' : 'passes'} an MCP server with ${name}`, async ($, on) => {
    const toast = await start($, on, {
      [MCP]: JSON.stringify({ mcpServers: { a: server } }),
      '/home/me/.claude.json': JSON.stringify({ projects: { '/repo': { mcpServers: { a: server } } } }),
    })
    const expected = `${count} ${count === 1 ? 'entry looks' : 'entries look'}`
    expect(toast.includes(`/repo/.mcp.json: ${expected}`)).toBe(count > 0)
    expect(toast.includes(`/home/me/.claude.json: ${expected}`)).toBe(count > 0)
    expect(count > 0 || toast === '').toBe(true)
  })
}

test('never shows a secret from any place it reads, well-formed or not', async ($, on) => {
  const secrets = [AWS, GITHUB, OPENAI, API_KEY, PASSWORD, SLACK_APP, SLACK_HOOK, AZURE, 'ab'.repeat(10)]
  const server = {
    command: `PGPASSWORD=${PASSWORD} npx`,
    args: ['--api-key', API_KEY, GITHUB, SLACK_APP],
    url: `https://user:${PASSWORD}@mcp.example.com/mcp?api_key=${API_KEY}`,
    env: { OPENAI_API_KEY: OPENAI, STORAGE: AZURE },
    headers: { Authorization: BEARER },
  }
  const whole = JSON.stringify({ permissions: { allow: [`Bash(echo ${AWS})`, `Bash(curl https://${SLACK_HOOK})`] }, env: server.env, mcpServers: { a: server } })
  const toast = await start(
    $,
    on,
    {
      [LOCAL]: whole,
      [MCP]: `﻿${whole.slice(0, -1)},}`,
      '/home/me/.claude.json': `// broken\n${whole}`,
      '/home/me/.claude/settings.json': whole.slice(0, -3),
    },
    { 'ls-files': 0 },
  )
  expect(toast.includes('/repo/.claude/settings.local.json: 9 entries look')).toBe(true)
  expect(toast.includes('/repo/.mcp.json: 9 entries look')).toBe(true)
  expect(toast.includes('/home/me/.claude.json: 1 entry looks')).toBe(true)
  expect(toast.includes('/home/me/.claude/settings.json: 1 entry looks')).toBe(true)
  for (const secret of secrets) {
    expect(toast.includes(secret)).toBe(false)
  }
})

// Each took seconds, or never ended, while a run before a later literal was unbounded.
for (const fragment of ['docker login ', 'a', '-', 'sshpass ', 'mysql ', 'redis-cli ', 'eyJ-', 'token_a']) {
  test(`reads 100 KB of ${JSON.stringify(fragment)} without holding session start`, async ($, on) => {
    const big = fragment.repeat(Math.ceil(100_000 / fragment.length))
    const began = Date.now()
    expect(await start($, on, { [MCP]: JSON.stringify({ mcpServers: { a: { command: big, env: { A: big } } } }), [LOCAL]: big }, IGNORED)).toBe('')
    expect(Date.now() - began < 3_000).toBe(true)
  })
}

test('flags a local settings file tracked by git', async ($, on) => {
  const toast = await start($, on, { [LOCAL]: settings('Bash(ls)') }, { 'ls-files': 0 })
  expect(/tracked by git/.test(toast)).toBe(true)
})

test('flags a local settings file git would commit', async ($, on) => {
  const toast = await start($, on, { [LOCAL]: settings('Bash(ls)') }, { 'ls-files': 1, 'check-ignore': 1 })
  expect(/not git-ignored/.test(toast)).toBe(true)
})

test('stays quiet on a clean, ignored file', async ($, on) => {
  expect(await start($, on, { [LOCAL]: settings('Bash(ls)') }, IGNORED)).toBe('')
})

test('still warns of a secret when git cannot start', async ($, on) => {
  const toast = await start($, on, { [LOCAL]: settings(`Bash(echo ${AWS})`) }, 'missing')
  expect(/literal secret/.test(toast)).toBe(true)
})

test('stays quiet outside a git repo', async ($, on) => {
  expect(await start($, on, { [LOCAL]: settings('Bash(ls)') })).toBe('')
})
