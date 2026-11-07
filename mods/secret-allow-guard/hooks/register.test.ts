import type { EngineInterface, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Fake values built at run time, so no fixture reads as a real key to a scanner.
const AWS = `AKIA${'X'.repeat(16)}`
const GITHUB = `ghp_${'a1'.repeat(18)}`
const OPENAI = `sk-${'z9'.repeat(12)}`
const AUTH = ['Author', 'ization: Bearer'].join('')

const settings = (...allow: string[]) => JSON.stringify({ permissions: { allow } })

// The session's folder and the user's home, both with settings files from `files`; git answers each subcommand with `git`'s exit code.
// `git` 'missing' makes every git run reject, as when git is not installed.
const start = async ($: EngineInterface, on: On, files: Record<string, string>, git: Record<string, number> | 'missing' = {}) => {
  mock.env(on, { USERPROFILE: '/home/me' })
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
  expect(toast.includes('1 permission rule looks like')).toBe(true)
})

test('scans the shared and user settings too', async ($, on) => {
  const toast = await start($, on, {
    '/repo/.claude/settings.json': settings(`Bash(echo ${AWS})`),
    '/home/me/.claude/settings.json': settings(`Bash(echo ${GITHUB})`, `Bash(echo ${OPENAI})`),
  })
  expect(toast.includes('/repo/.claude/settings.json: 1 permission rule')).toBe(true)
  expect(toast.includes('/home/me/.claude/settings.json: 2 permission rules')).toBe(true)
})

test('scans a file that does not parse, whole', async ($, on) => {
  const toast = await start($, on, { [LOCAL]: `{ "permissions": { "allow": ["Bash(echo ${AWS})", ] } }` }, IGNORED)
  expect(/literal secret/.test(toast)).toBe(true)
})

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
