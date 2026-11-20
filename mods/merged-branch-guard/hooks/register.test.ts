import type { EngineInterface, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const OID = '0123456789abcdef0123456789abcdef01234567'
const URL = 'https://github.com/example-org/widgets/pull/91'
const MERGED = { state: 'MERGED', number: 91, url: URL, headRefOid: OID }
const OPEN = { state: 'OPEN', number: 92, url: 'https://github.com/example-org/widgets/pull/92', headRefOid: 'f'.repeat(40) }
const NOTE = /could not ask GitHub whether (feat\/x|the pushed branch)'s PR is merged/

// What the repo and GitHub answer: the checked-out branch ('' when detached), origin's default branch, gh's reply (or 'throw'),
// ls-remote's exit code (2: the branch is gone), is-ancestor's (0: the merged head is in what is pushed), and a session with no folder.
type World = {
  lsRemote?: number
  isAncestor?: number
  noCwd?: boolean
  current?: string
  base?: string
  gh?: { exitCode?: number; stdout?: string; stderr?: string } | 'throw'
  tool?: string
}

const out = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const push = async ($: EngineInterface, on: On, command: string, world: World = {}) => {
  const { current = 'feat/x', base = 'main', gh = { stdout: JSON.stringify([MERGED]) }, tool = 'Bash', lsRemote = 2, isAncestor = 0 } = world
  const asked: { argv: readonly string[]; cwd: string | undefined }[] = []
  let hasRun = false

  on('session.cwd', () => {
    if (world.noCwd) {
      throw new Error('no folder')
    }

    return { value: 'C:/repos/widgets' }
  })
  on('process.run', (_, e) => {
    asked.push({ argv: e.argv, cwd: e.init?.cwd })

    if (e.argv[0] === 'gh') {
      if (gh === 'throw') {
        throw new Error('spawn gh ENOENT')
      }

      return out(gh.stdout ?? '', gh.exitCode ?? 0, gh.stderr ?? '')
    }

    if (e.argv.includes('ls-remote') || e.argv.includes('merge-base')) {
      return out('', e.argv.includes('ls-remote') ? lsRemote : isAncestor)
    }

    if (e.argv.includes('rev-parse')) {
      return out('abc1234\n')
    }

    const ref = e.argv.at(-1) ?? ''
    const answer = ref === 'HEAD' ? current : `${ref.split('/')[2]}/${base}`

    return e.argv.includes('symbolic-ref') && answer !== '' ? out(`${answer}\n`) : out('', 1)
  })
  on('tool.call', { tool: [tool] }, () => {
    hasRun = true

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const ran = JSON.stringify(await $.tool.call({ tool, command } as never))

  return { hasRun, ran, asked, gh: asked.filter(one => one.argv[0] === 'gh') }
}

for (const command of [
  'git push origin feat/x',
  'git push -u origin feat/x',
  'git push origin HEAD',
  'git push',
  'git push origin',
  'git push -u origin',
  'git push origin local:feat/x',
  'git push origin HEAD:refs/heads/feat/x',
  'git push origin +feat/x',
  'git push origin main feat/x',
  'git push origin @',
  'git push origin @:feat/x',
  'git push origin HEAD:',
  'git push origin HEAD:$(git branch --show-current)',
  'git push origin "$(git branch --show-current)"',
  "git push origin ' '",
  'git push -o ci.skip origin feat/x',
  'git -C other push origin feat/x',
  'git add -A && git commit -m fix && git push origin feat/x',
]) {
  test(`denies a push to a merged branch: ${command}`, async ($, on) => {
    const { hasRun, ran, gh } = await push($, on, command)

    expect(hasRun).toBe(false)
    expect(ran).toContain('merged-branch-guard: feat/x')
    expect(gh.map(one => one.argv.slice(0, 5))).toEqual([['gh', 'pr', 'list', '--head', 'feat/x']])
  })
}

test('the deny names the merged PR and the commands for a follow-up branch', async ($, on) => {
  const { ran } = await push($, on, 'git push origin feat/x')

  for (const part of ['#91', URL, 'git fetch origin', 'git switch -c feat/x-followup origin/main', `git cherry-pick ${OID}..feat/x`, 'git push -u origin feat/x-followup']) {
    expect(ran).toContain(part)
  }
})

// The commits to move sit on the refspec's source, named so it still points at them after the switch.
for (const [command, current, tip] of [
  ['git push origin local:feat/x', 'feat/x', 'local'],
  ['git push origin HEAD:feat/x', 'wip', 'wip'],
  ['git push origin HEAD:feat/x', '', 'abc1234'],
  ['git push origin @:feat/x', 'wip', 'wip'],
  ['git push origin HEAD~1:feat/x', 'wip', 'abc1234'],
] as const) {
  test(`the cherry-pick takes the commits from ${tip}: ${command}`, async ($, on) => {
    const { ran } = await push($, on, command, { current })

    expect(ran).toContain(`git cherry-pick ${OID}..${tip}`)
  })
}

test('the follow-up branch starts from the remote and default branch the repo has', async ($, on) => {
  const { ran } = await push($, on, 'git push upstream feat/x', { base: 'develop' })

  expect(ran).toContain('git switch -c feat/x-followup upstream/develop')
})

test('git and gh are asked about the folder -C names', async ($, on) => {
  const { asked, gh } = await push($, on, 'git -C other push origin HEAD')

  expect(asked[0]?.argv).toEqual(['git', '-C', 'other', 'symbolic-ref', '--short', '-q', 'HEAD'])
  expect(gh[0]?.cwd).toBe('C:/repos/widgets/other')
})

test('the PowerShell tool is denied too', async ($, on) => {
  expect((await push($, on, 'git push origin feat/x', { tool: 'PowerShell' })).hasRun).toBe(false)
})

// command, the world, and whether gh is asked
const ALLOWED: readonly (readonly [string, World, boolean])[] = [
  ['git push origin feat/x', { gh: { stdout: JSON.stringify([OPEN]) } }, true],
  ['git push origin feat/x', { gh: { stdout: JSON.stringify([MERGED, OPEN]) } }, true],
  ['git push origin feat/x', { gh: { stdout: '[]' } }, true],
  ['git push origin v1.2.3', { gh: { stdout: '[]' } }, true],
  ['git push origin feat/x', { gh: { stdout: JSON.stringify([{ ...MERGED, state: 'CLOSED' }]) } }, true],
  // A long-lived branch merged by PR is still on the remote; a reused name does not hold the merged head.
  ['git push origin develop', { lsRemote: 0 }, true],
  ['git push origin feat/x', { isAncestor: 1 }, true],
  ['git push origin tag v1', {}, false],
  ['git push origin main', {}, false],
  ['git push origin master', {}, false],
  ['git push', { current: 'main' }, false],
  ['git push origin develop', { base: 'develop' }, false],
  ['git push origin refs/tags/v1', {}, false],
  ['git push origin v1:refs/tags/v1', {}, false],
  ['git push --tags', {}, false],
  ['git push --delete origin feat/x', {}, false],
  ['git push origin -d feat/x', {}, false],
  ['git push origin :feat/x', {}, false],
  ['git push --dry-run origin feat/x', {}, false],
  ['git push -n origin feat/x', {}, false],
  ['git push --mirror origin', {}, false],
  ['git push', { current: '' }, false],
  ['echo "git push origin feat/x"', {}, false],
]

for (const [command, world, asksGh] of ALLOWED) {
  test(`runs: ${command} ${JSON.stringify(world)}`, async ($, on) => {
    const { hasRun, ran, gh } = await push($, on, command, world)

    expect(hasRun).toBe(true)
    expect(gh.length).toBe(asksGh ? 1 : 0)
    expect(ran).not.toContain('merged-branch-guard')
  })
}

test('a git command that is not a push starts no process', async ($, on) => {
  const { hasRun, asked } = await push($, on, 'git status && git log --grep push')

  expect(hasRun).toBe(true)
  expect(asked).toEqual([])
})

const UNREACHABLE: readonly (readonly [string, World])[] = [
  ['gh is missing or times out', { gh: 'throw' }],
  ['gh is not signed in', { gh: { exitCode: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login' } }],
  ['gh prints something that is not JSON', { gh: { stdout: 'garbage' } }],
  ['gh prints JSON that is not a list', { gh: { stdout: '{}' } }],
  ['the remote cannot be listed', { lsRemote: 128 }],
  ['the session has no folder', { noCwd: true }],
]

for (const [name, world] of UNREACHABLE) {
  test(`fails open with a note when ${name}`, async ($, on) => {
    const { hasRun, ran } = await push($, on, 'git push origin feat/x', world)

    expect(hasRun).toBe(true)
    expect(NOTE.test(ran)).toBe(true)
    expect(ran).not.toContain('guard failed')
  })
}

// Monitor and the desktop app's terminal tool hand a command line to a shell too: they are checked like Bash.
for (const tool of ['Monitor', 'mcp__terminal__run_in_terminal']) {
  test(`${tool} is denied what Bash is, and runs the rest`, async ($, on) => {
    const ran: string[] = []

    on('session.cwd', () => ({ value: 'C:/repos/widgets' }))

    on('process.run', (_, e) => (e.argv[0] === 'gh' ? out(JSON.stringify([MERGED])) : out(e.argv.includes('ls-remote') ? '' : 'origin/main\n', e.argv.includes('ls-remote') ? 2 : 0)))
    on('tool.call', { tool: [tool] }, (_, e) => {
      ran.push(String(e.command))

      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const denied = JSON.stringify(await $.tool.call({ tool, command: 'git push origin feat/x' } as never))
    await $.tool.call({ tool, command: 'git status' } as never)
    // A Monitor that opens a WebSocket has no command.
    await $.tool.call({ tool, ws: { url: 'wss://example.com/events' } } as never)

    expect(ran).toEqual(['git status', 'undefined'])
    expect(denied).toContain('#91')
  })
}
