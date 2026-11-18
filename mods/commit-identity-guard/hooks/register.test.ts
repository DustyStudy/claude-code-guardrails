import type { EngineInterface, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const COVERED = 'https://github.com/example-org/widgets.git'
const OTHER = 'git@github.com:someone/else.git'
const NOREPLY = '12345+octocat@users.noreply.github.com'
const TRAILER = 'Co-Authored-By: Claude Opus <noreply@anthropic.com>'

const TRAILERS = /no Claude trailers/
const ADDRESS = /noreply address only/

// remote, configured email, command, then true when it runs or the reason it is denied for, and the commit an amend rewrites
const CASES: readonly (readonly [string, string, string, string, true | RegExp, { author?: string; message?: string }?])[] = [
  ['a commit through git.exe from a personal address', COVERED, 'me@example.com', 'git.exe commit -m fix', ADDRESS],
  ['a PR through gh.exe with the Claude line', COVERED, NOREPLY, 'gh.exe pr create --title t --body "Generated with Claude Code"', TRAILERS],
  ['an inline personal author.email', COVERED, NOREPLY, 'git -c author.email=me@example.com commit -m fix', ADDRESS],
  ['an inline personal committer.email', COVERED, NOREPLY, 'git -c committer.email=me@example.com commit -m fix', ADDRESS],
  ['an amend that keeps a personal author', COVERED, NOREPLY, 'git commit --amend --no-edit', ADDRESS, { author: 'me@example.com' }],
  ['an amend that resets a personal author', COVERED, NOREPLY, 'git commit --amend --no-edit --reset-author', true, { author: 'me@example.com' }],
  ['an amend that keeps a Claude trailer', COVERED, NOREPLY, 'git commit --amend --no-edit', /amended carries a Claude trailer/, { message: `feat: x\n\n${TRAILER}` }],
  ['an amend that rewrites a Claude-trailer message', COVERED, NOREPLY, 'git commit --amend -m "feat: x"', true, { message: `feat: x\n\n${TRAILER}` }],
  ['a clean commit', COVERED, NOREPLY, 'git commit -m "feat: add x"', true],
  ['a commit with a Claude trailer', COVERED, NOREPLY, `git commit -m "feat: x\n\n${TRAILER}"`, TRAILERS],
  ['a trailer in a heredoc message', COVERED, NOREPLY, `git commit -m "$(cat <<'EOF'\nfeat: x\n\n${TRAILER}\nEOF\n)"`, TRAILERS],
  ['a commit from a personal address', COVERED, 'me@example.com', 'git add -A && git commit -m "fix: y"', ADDRESS],
  ['an inline personal address', COVERED, NOREPLY, 'git -c user.email=me@example.com commit -m "fix: y"', ADDRESS],
  ['an inline noreply address over a personal config', COVERED, 'me@example.com', `git -c user.email=${NOREPLY} commit -m "fix: y"`, true],
  ['a noreply author over a personal committer', COVERED, 'me@example.com', `git commit --author="Jane Doe <${NOREPLY}>" -m "fix: y"`, ADDRESS],
  ['a noreply committer over a personal author', COVERED, 'me@example.com', `GIT_COMMITTER_EMAIL=${NOREPLY} git commit -m "fix"`, ADDRESS],
  ['a personal config behind a message that names user.email=', COVERED, 'me@example.com', 'git commit -m "document user.email=example"', ADDRESS],
  ['both identities set to noreply over a personal config', COVERED, 'me@example.com', `GIT_AUTHOR_EMAIL=${NOREPLY} GIT_COMMITTER_EMAIL=${NOREPLY} git commit -m fix`, true],
  ['a message that names a personal user.email=, over a noreply config', COVERED, NOREPLY, 'git commit -m "document user.email=me@example.com"', true],
  ['a personal config behind a user.name that reads user.email=', COVERED, 'me@example.com', 'git -c user.name="user.email=" commit -m fix', ADDRESS],
  ['a personal config behind empty identity variables', COVERED, 'me@example.com', 'echo GIT_AUTHOR_EMAIL= GIT_COMMITTER_EMAIL=; git commit -m fix', ADDRESS],
  ['an amend under a noreply config', COVERED, NOREPLY, 'git commit --amend --no-edit', true],
  ['an amend under a personal config', COVERED, 'me@example.com', 'git commit --amend --no-edit', ADDRESS],
  ['a PR body with the Claude line', COVERED, NOREPLY, 'gh pr create --title t --body "x\n\nGenerated with [Claude Code](https://claude.com/claude-code)"', TRAILERS],
  ['a PR with the Claude line, aimed at a covered owner by -R', OTHER, NOREPLY, 'gh pr create -R example-org/widgets --title t --body "Generated with Claude Code"', TRAILERS],
  ['a clean PR', COVERED, 'me@example.com', 'gh pr create --title t --body "x"', true],
  ['a trailer in another owner\'s repo', OTHER, 'me@example.com', `git commit -m "x\n\n${TRAILER}"`, true],
  ['a commit outside any repo', '', '', 'git commit -m "x"', true],
  ['a personal address after a quoted -c value', COVERED, 'me@example.com', 'git -c user.name="Jane Doe" commit -m "fix: y"', ADDRESS],
  ['a command that is not a commit', COVERED, 'me@example.com', 'git log --grep commit', true],
  ['a commit through a quoted path to git', COVERED, 'me@example.com', '& "C:/tools/git.exe" commit -m fix', ADDRESS],
  ['two commits in one command', COVERED, NOREPLY, 'git -C a commit -m x && git -C b commit -m y', /one git commit per command/],
  ['a commit reusing a personal author by -C', COVERED, NOREPLY, 'git commit -C abc123', ADDRESS, { author: 'me@example.com' }],
  ['a commit reusing a Claude-trailer message by --reuse-message', COVERED, NOREPLY, 'git commit --reuse-message=abc123', /Claude trailer/, { message: `feat: x\n\n${TRAILER}` }],
  ['a commit reusing a clean noreply commit', COVERED, NOREPLY, 'git commit -C abc123', true],
  ['a message that names git commit', COVERED, NOREPLY, 'git commit -m "fix: guard git commit identity"', true],
  ['a commit split by a line continuation', COVERED, NOREPLY, `git \\\ncommit -m "x\n\n${TRAILER}"`, TRAILERS],
  ['a commit through GIT in capitals', COVERED, 'me@example.com', 'GIT commit -m fix', ADDRESS],
  ['a commit with quotes inside the subcommand', COVERED, 'me@example.com', 'git c""ommit -m fix', ADDRESS],
  ['a commit after --work-tree and its value', COVERED, 'me@example.com', 'git --work-tree . commit -m fix', ADDRESS],
  ['a PR with gh options before pr', OTHER, NOREPLY, 'gh -R example-org/widgets pr create --title t --body "Generated with Claude Code"', TRAILERS],
  ['a PR aimed at a covered owner by an attached -R', OTHER, NOREPLY, 'gh pr create -Rexample-org/widgets --title t --body "Generated with Claude Code"', TRAILERS],
  ['a squash merge body with the Claude line', COVERED, NOREPLY, `gh pr merge 3 --squash --body "${TRAILER}"`, TRAILERS],
  ['a squash merge under a personal address', COVERED, NOREPLY, 'gh pr merge 3 --squash --author-email me@example.com', ADDRESS],
  ['a clean squash merge', COVERED, 'me@example.com', 'gh pr merge 3 --squash', true],
  ['a --trailer written with =', COVERED, NOREPLY, 'git commit -m x --trailer "Co-Authored-By=Claude <noreply@anthropic.com>"', TRAILERS],
  ['a trailer with quotes inside its words', COVERED, NOREPLY, 'git commit -m x -m "Co-Authored-By: Cl""aude <noreply@anthr""opic.com>"', TRAILERS],
  ['an abbreviated amend that keeps a personal author', COVERED, NOREPLY, 'git commit --ame --no-edit', ADDRESS, { author: 'me@example.com' }],
  ['an amend left to the editor that keeps a Claude trailer', COVERED, NOREPLY, 'GIT_EDITOR=true git commit --amend', /Claude trailer/, { message: `feat: x\n\n${TRAILER}` }],
  ['an amend with a new message given as -am', COVERED, NOREPLY, 'git commit --amend -am "feat: x"', true, { message: `feat: x\n\n${TRAILER}` }],
  ['a commit reusing a personal author by -c', COVERED, NOREPLY, 'git commit -c abc123', ADDRESS, { author: 'me@example.com' }],
  ['an inline personal address under USER.EMAIL', COVERED, NOREPLY, 'git -c USER.EMAIL=me@example.com commit -m fix', ADDRESS],
  ['an inline personal address with quotes inside the key', COVERED, NOREPLY, 'git -c user.ema"il"=me@example.com commit -m fix', ADDRESS],
  ['an inline address with no @', COVERED, NOREPLY, 'git -c user.email=localhost commit -m fix', ADDRESS],
  ['a personal author set the PowerShell way', COVERED, NOREPLY, "$env:GIT_AUTHOR_EMAIL = 'me@example.com'; git commit -m fix", ADDRESS],
  ['a personal config behind identity variables that are only printed', COVERED, 'me@example.com', `echo GIT_AUTHOR_EMAIL=${NOREPLY} GIT_COMMITTER_EMAIL=${NOREPLY} && git commit -m fix`, ADDRESS],
  ['an author looked up by a pattern', COVERED, NOREPLY, 'git commit --author=jane -m fix', ADDRESS],
  ['an abbreviated --author', COVERED, NOREPLY, 'git commit --auth="Jane <me@example.com>" -m fix', ADDRESS],
  ['a noreply author under a noreply config', COVERED, NOREPLY, `git commit --author="Jane <${NOREPLY}>" -m fix`, true],
  ['a personal address configured in the same command', COVERED, NOREPLY, 'git config user.email me@example.com && git commit -m fix', ADDRESS],
  ['a read of user.email in the same command', COVERED, NOREPLY, 'git config user.email && git commit -m fix', true],
  ['an identity from config the guard cannot read', COVERED, NOREPLY, 'GIT_CONFIG_GLOBAL=/tmp/other.gitconfig git commit -m fix', /cannot read/],
  ['an identity from --config-env', COVERED, NOREPLY, 'ADDRESS=me@example.com git --config-env=user.email=ADDRESS commit -m fix', /cannot read/],
  ['a personal config behind a user.name that reads -c user.email=', COVERED, 'me@example.com', `git -c user.name="x -c user.email=${NOREPLY}" commit -m fix`, ADDRESS],
  ['a personal config behind another variable that reads as both identities', COVERED, 'me@example.com', `X="GIT_AUTHOR_EMAIL=${NOREPLY} GIT_COMMITTER_EMAIL=${NOREPLY}" git commit -m fix`, ADDRESS],
  ['both identities quoted, over a personal config', COVERED, 'me@example.com', `GIT_AUTHOR_EMAIL="${NOREPLY}" GIT_COMMITTER_EMAIL="${NOREPLY}" git commit -m fix`, true],
  ['a message that names an author option', COVERED, NOREPLY, 'git commit -m "fix: read --author values"', true],
  ['a quoted inline noreply address over a personal config', COVERED, 'me@example.com', `git -c "user.email=${NOREPLY}" commit -m fix`, true],
  ['a PR opened after git add -A', COVERED, NOREPLY, 'git add -A; gh pr create --title t --body x', true],
  ['a read of user.email on the line before the commit', COVERED, NOREPLY, 'git config user.email\ngit commit -m fix', true],
  ['a message that names both in prose', COVERED, NOREPLY, 'git commit -m "docs: a co-authored-by line from Claude is denied"', true],
]

for (const [name, remote, email, command, expected, head] of CASES) {
  const isAllowed = expected === true

  test(`${isAllowed ? 'runs' : 'denies'} ${name}`, async ($, on) => {
    mock.env(on, { COMMIT_GUARD_OWNERS: 'other-org, example-org' })
    let hasRun = false

    on('process.run', ($, e) => ({
      value: {
        exitCode: 0,
        stdout: e.argv.includes('remote')
          ? `${remote}\n`
          : e.argv.includes('var')
            ? `Jane Doe <${email}> 1792700000 +0000\n`
            : // `log -1 --format=%ae%n%B` of the commit an amend rewrites: its author, then its message.
              `${head?.author ?? email}\n${head?.message ?? 'feat: x'}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }))
    on('tool.call', { tool: ['Bash'] }, () => {
      hasRun = true

      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const ran = JSON.stringify(await $.tool.call({ tool: 'Bash', command }))

    expect(hasRun).toBe(isAllowed)

    // The denial must be the policy's own, not a guard that threw.
    if (expected !== true) {
      expect(expected.test(ran)).toBe(true)
    }
  })
}

test('reads -C among the global options only', async ($, on) => {
    mock.env(on, { COMMIT_GUARD_OWNERS: 'other-org, example-org' })
  const asked: string[] = []

  on('process.run', ($, e) => {
    asked.push(e.argv.join(' '))

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: ['Bash'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  await $.tool.call({
    tool: 'Bash',
    command: 'git -c user.name="Jane Doe" -C /c/repos/x commit -C HEAD',
  })

  expect(asked).toEqual(['git -C c:/repos/x remote get-url origin'])
})

test('passes a quoted folder whole, and every -C in order', async ($, on) => {
    mock.env(on, { COMMIT_GUARD_OWNERS: 'other-org, example-org' })
  const asked: (readonly string[])[] = []

  on('process.run', ($, e) => {
    asked.push(e.argv)

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: ['Bash'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  await $.tool.call({ tool: 'Bash', command: 'git -C "C:/repos/my project" -C sub commit -m fix' })

  expect(asked).toEqual([['git', '-C', 'C:/repos/my project', '-C', 'sub', 'remote', 'get-url', 'origin']])
})

test('asks git about the folder the command names', async ($, on) => {
    mock.env(on, { COMMIT_GUARD_OWNERS: 'other-org, example-org' })
  const asked: string[] = []

  on('process.run', ($, e) => {
    asked.push(e.argv.join(' '))

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: ['Bash'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  await $.tool.call({ tool: 'Bash', command: 'cd /c/repos/widgets && git commit -m x' })

  expect(asked).toEqual(['git -C c:/repos/widgets remote get-url origin'])
})

test('with no owners set, nothing is checked', async ($, on) => {
  mock.env(on, {})
  let hasRun = false
  on('tool.call', { tool: ['Bash'] }, () => {
    hasRun = true

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  await $.tool.call({ tool: 'Bash', command: `git commit -m "x\n\n${TRAILER}"` })

  expect(hasRun).toBe(true)
})

test('an owner name that is not a GitHub name is ignored, not read as a pattern', async ($, on) => {
  mock.env(on, { COMMIT_GUARD_OWNERS: '.*' })
  let hasRun = false
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${COVERED}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', { tool: ['Bash'] }, () => {
    hasRun = true

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  await $.tool.call({ tool: 'Bash', command: `git commit -m "x\n\n${TRAILER}"` })

  expect(hasRun).toBe(true)
})

// A covered repo with a noreply identity, its message files served from `files`; returns whether the command ran and the files read.
const withFiles = async ($: EngineInterface, on: On, command: string, files: Record<string, string>) => {
  mock.env(on, { COMMIT_GUARD_OWNERS: 'example-org' })
  const read: string[] = []
  let hasRun = false
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('remote') ? `${COVERED}\n` : `Jane Doe <${NOREPLY}> 1792700000 +0000\n`,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.read', (_, e) => {
    // The file name, as the host resolves a path its own way on each platform.
    const path = e.path.replace(/\\/g, '/')
    const name = Object.keys(files).find(one => path.endsWith(one))
    read.push(path)
    if (name === undefined) {
      throw new Error('ENOENT')
    }

    return { value: files[name] }
  })
  on('tool.call', { tool: ['Bash'] }, () => {
    hasRun = true

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const ran = JSON.stringify(await $.tool.call({ tool: 'Bash', command }))

  return { hasRun, ran, read }
}

for (const command of ['git commit -F msg.txt', 'git commit -aF msg.txt', 'git commit --fil msg.txt', 'gh pr merge 3 --squash -F msg.txt', 'git commit -Fmsg.txt', 'gh pr create --title t -Fmsg.txt','git commit --file=msg.txt', 'git commit --file "msg.txt"', 'gh pr create --title t --body-file msg.txt', 'gh pr edit 3 -F msg.txt']) {
  test(`denies a Claude trailer read from a file: ${command}`, async ($, on) => {
    const { hasRun, ran } = await withFiles($, on, command, { 'msg.txt': `feat: x\n\n${TRAILER}\n` })
    expect(hasRun).toBe(false)
    expect(TRAILERS.test(ran)).toBe(true)
  })
}

test('runs a clean message file', async ($, on) => {
  expect((await withFiles($, on, 'git commit -F msg.txt', { 'msg.txt': 'feat: x\n' })).hasRun).toBe(true)
})

test('runs a message file it cannot read', async ($, on) => {
  expect((await withFiles($, on, 'git commit -F gone.txt', {})).hasRun).toBe(true)
})

test('reads a message file from the folder the command names', async ($, on) => {
  const { hasRun, read } = await withFiles($, on, 'cd /c/repos/widgets && git commit -F .git/msg.txt', { 'widgets/.git/msg.txt': TRAILER })
  expect(hasRun).toBe(false)
  expect(read.some(path => path.endsWith('repos/widgets/.git/msg.txt'))).toBe(true)
})

test('a message piped in is not read', async ($, on) => {
  const { hasRun, read } = await withFiles($, on, 'printf "x" | git commit -F -', {})
  expect(hasRun).toBe(true)
  expect(read).toEqual([])
})

// Monitor and the desktop app's terminal tool hand a command line to a shell too: they are checked like Bash.
for (const tool of ['Monitor', 'mcp__terminal__run_in_terminal']) {
  test(`${tool} is denied what Bash is, and runs the rest`, async ($, on) => {
    mock.env(on, { COMMIT_GUARD_OWNERS: 'example-org' })
    const ran: string[] = []

    on('process.run', (_, e) => ({
      value: { exitCode: 0, stdout: e.argv.includes('remote') ? `${COVERED}\n` : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    on('tool.call', { tool: [tool] }, (_, e) => {
      ran.push(String(e.command))

      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const denied = JSON.stringify(await $.tool.call({ tool, command: `git commit -m "x\n\n${TRAILER}"` } as never))
    await $.tool.call({ tool, command: 'git status' } as never)
    // A Monitor that opens a WebSocket has no command.
    await $.tool.call({ tool, ws: { url: 'wss://example.com/events' } } as never)

    expect(ran).toEqual(['git status', 'undefined'])
    expect(TRAILERS.test(denied)).toBe(true)
  })
}
