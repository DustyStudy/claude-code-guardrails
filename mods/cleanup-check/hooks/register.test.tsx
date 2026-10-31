import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { leftovers } from './register'

const CLEAN = { current: 'main', base: 'main', merged: ['main'], gone: [], pushed: ['main'], elsewhere: [], untracked: [] }

test('a clean repo on its base has nothing left', () => {
  expect(leftovers(CLEAN)).toEqual([])
})

test('a branch just made from the base is not taken for merged work', () => {
  expect(leftovers({ ...CLEAN, current: 'feat/new', merged: ['main', 'feat/new'] })).toEqual([])
})

test('a branch whose remote went with a squash merge is finished', () => {
  expect(leftovers({ ...CLEAN, current: 'feat/done', gone: ['feat/done'], pushed: ['main', 'feat/done'] })).toEqual([
    'feat/done is merged: switch to main and pull',
  ])
})

test('other finished branches and saved plans are listed, not ones in another worktree', () => {
  expect(
    leftovers({
      ...CLEAN,
      merged: ['main', 'fix/a', 'scratch', 'wt'],
      gone: ['feat/b'],
      pushed: ['main', 'fix/a', 'feat/b', 'wt'],
      elsewhere: ['wt'],
      untracked: ['.terraform/', 'stack/tfplan', 'gd.tfplan', 'notes.md'],
    }),
  ).toEqual(['2 merged branches to delete: fix/a, feat/b', '2 saved plans: stack/tfplan, gd.tfplan'])
})

// Answers git beneath the mod from a table of argv prefixes, and records the status line.
const repo = (on: On, answers: Record<string, string | null>) => {
  const status: (string | undefined)[] = []
  on('session.cwd', () => ({ value: 'C:\\repos\\stack\\envs' }))
  on('process.run', (_, e) => {
    const key = Object.keys(answers).find(prefix => e.argv.join(' ').startsWith(prefix))
    const stdout = key === undefined ? null : answers[key]

    return {
      value: { exitCode: stdout === null || stdout === undefined ? 128 : 0, stdout: stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.status', (_, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))

  return status
}

const ROOT = { 'git rev-parse --show-toplevel': 'C:/repos/stack\n' }

test('at the end of a turn the status line lists what is left, plans from the repo root', async ($, on) => {
  const status = repo(on, {
    ...ROOT,
    'git rev-parse --abbrev-ref HEAD': 'feat/done\n',
    'git symbolic-ref': 'origin/main\n',
    'git branch --merged origin/main': 'main\nfeat/done\n',
    'git for-each-ref':
      'main|refs/remotes/origin/main||C:/repos/stack\nfeat/done|refs/remotes/origin/feat/done|[gone]|\nlocal|||\n',
    'git ls-files -z --others --exclude-standard': 'newdir/tfplan\0notes.md\0',
    'git ls-files -z --others --ignored': '.terraform/\0tfplan\0',
  })
  await $.turn.complete({ reason: 'answer', answer: '' } as never)

  expect(status).toEqual(['Cleanup: feat/done is merged: switch to main and pull · 2 saved plans: newdir/tfplan, tfplan'])
})

test('a branch made from origin/main tracks it, which is not being pushed', async ($, on) => {
  const status = repo(on, {
    ...ROOT,
    'git rev-parse --abbrev-ref HEAD': 'feat/new\n',
    'git symbolic-ref': 'origin/main\n',
    'git branch --merged origin/main': 'main\nfeat/new\n',
    'git for-each-ref': 'main|refs/remotes/origin/main||C:/repos/stack\nfeat/new|refs/remotes/origin/main||\n',
    'git ls-files': '',
  })
  await $.turn.complete({ reason: 'answer', answer: '' } as never)

  expect(status).toEqual([undefined])
})

test('a detached HEAD still reports saved plans', async ($, on) => {
  const status = repo(on, {
    ...ROOT,
    'git rev-parse --abbrev-ref HEAD': 'HEAD\n',
    'git symbolic-ref': 'origin/main\n',
    'git branch --merged': 'main\n',
    'git for-each-ref': 'main|refs/remotes/origin/main||\n',
    'git ls-files -z --others --exclude-standard': '',
    'git ls-files -z --others --ignored': 'gd.tfplan\0',
  })
  await $.turn.complete({ reason: 'answer', answer: '' } as never)

  expect(status).toEqual(['Cleanup: 1 saved plan: gd.tfplan'])
})

test('outside a git repo the status line is cleared', async ($, on) => {
  const status = repo(on, {})
  await $.turn.complete({ reason: 'answer', answer: '' } as never)

  expect(status).toEqual([undefined])
})

test('a subagent ending its turn runs no git', async ($, on) => {
  const status = repo(on, ROOT)
  await $.turn.complete({ reason: 'answer', answer: '', agentId: 'a1' } as never)

  expect(status).toEqual([])
})

const ABOVE = {
  plugin: 'cleanup-check',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('desktop shows what is left above the prompt, the terminal only in its status line', async ($, on) => {
  repo(on, {
    ...ROOT,
    'git rev-parse --abbrev-ref HEAD': 'main\n',
    'git symbolic-ref': 'origin/main\n',
    'git branch --merged': 'main\n',
    'git for-each-ref': 'main|refs/remotes/origin/main||\n',
    'git ls-files -z --others --exclude-standard': '',
    'git ls-files -z --others --ignored': 'gd.tfplan\0',
  })
  // Stands for the engine's own drawing beneath the mod.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  await $.turn.complete({ reason: 'answer', answer: '' } as never)

  const desktop = await $.ui.mount({ ...ABOVE, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: /saved plan/ }))?.text).toBe('1 saved plan: gd.tfplan')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...ABOVE, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: 'Cleanup' })).toBeUndefined()
  await terminal.unmount()
})

test('without origin/HEAD the base is main', async ($, on) => {
  const status = repo(on, {
    ...ROOT,
    'git rev-parse --abbrev-ref HEAD': 'main\n',
    'git symbolic-ref': null,
    'git branch --merged main': 'main\nold\n',
    'git for-each-ref': 'main|refs/remotes/origin/main||C:/repos/stack\nold|refs/remotes/origin/old||\n',
    'git ls-files': '',
  })
  await $.turn.complete({ reason: 'answer', answer: '' } as never)

  expect(status).toEqual(['Cleanup: 1 merged branch to delete: old'])
})
