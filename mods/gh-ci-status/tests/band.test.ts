import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'gh-ci-status',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// A box of the drawn row.
type Cell = { props: object; children: [{ props: object }] }

const OK = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

const JOB = 'https://github.com/o/r/actions/runs/7/job/99'

const node = (number: number, state: string | null, failing?: string) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  isDraft: false,
  headRefOid: `sha${number}`,
  repository: { nameWithOwner: 'o/r' },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup:
            state === null
              ? null
              : {
                  state,
                  contexts: { nodes: failing ? [{ name: failing, conclusion: 'FAILURE', detailsUrl: JOB }] : [] },
                },
        },
      },
    ],
  },
})

// The search answer: the person's own pull requests, then Dependabot's.
const answer = (mine: unknown[], bots: unknown[] = []) => JSON.stringify({ data: { mine: { nodes: mine }, bots: { nodes: bots } } })

// Answers gh beneath the mod: the query from `open`, and records every merge asked for.
const gh = (on: On, open: { nodes: unknown[]; bots?: unknown[] }, whileMerging?: () => Promise<void>) => {
  const merges: string[][] = []
  on('process.run', async (_, e) => {
    if (e.argv[1] === 'run') {
      merges.push([...e.argv])
      const log = Array.from({ length: 80 }, (_, i) => `build\tRun tests\t2026-10-22T10:00:00.0000000Z line ${i + 1}`)

      return { value: { ...OK, stdout: `${log.join('\n')}\n` } }
    }

    if (e.argv[1] === 'pr') {
      merges.push([...e.argv])
      await whileMerging?.()

      return { value: { ...OK, stdout: '' } }
    }

    return {
      value: {
        ...OK,
        stdout: answer(open.nodes, open.bots),
      },
    }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

  return merges
}

test('only a pull request whose checks passed gets Merge, and it takes two presses', async ($, on) => {
  const clock = mock.clock(on)
  const open = {
    nodes: [node(1, 'SUCCESS'), node(2, 'PENDING'), node(3, 'FAILURE', 'lint'), node(4, null)],
  }
  const merges = gh(on, open)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount(BAND)
  const key = 'merge-https://github.com/o/r/pull/1'
  expect(await ui.find({ key })).toBeDefined()
  for (const n of [2, 3, 4]) {
    expect(await ui.find({ key: `merge-https://github.com/o/r/pull/${n}` })).toBeUndefined()
  }
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text).join('|')).toMatch(
    /failed: lint.*no checks/,
  )

  await ui.press({ key })
  expect(merges).toEqual([])
  await ui.press({ key })
  expect(merges).toEqual([
    ['gh', 'pr', 'merge', 'https://github.com/o/r/pull/1', '--squash', '--delete-branch', '--match-head-commit', 'sha1'],
  ])
})

test("Dependabot's pull requests join the person's own, most recently updated first", async ($, on) => {
  const clock = mock.clock(on)
  const at = (n: number, updatedAt: string) => ({ ...node(n, 'SUCCESS'), updatedAt })
  on('tool.call', () => ({ result: '' }))
  gh(on, { nodes: [at(1, '2026-10-20T00:00:00Z'), at(3, '2026-10-10T00:00:00Z')], bots: [at(2, '2026-10-15T00:00:00Z')] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const got = await $.tool.call({ tool: 'mcp__gh-ci-status__checks' as const, tool_use_id: 't1' })
  expect(String(got.result).match(/#\d/g)).toEqual(['#1', '#2', '#3'])
})

test('while gh merges, the row says merging and has no button', async ($, on) => {
  const clock = mock.clock(on)
  const key = 'merge-https://github.com/o/r/pull/1'
  const seen: string[] = []
  let look = async () => {}
  const merges = gh(on, { nodes: [node(1, 'SUCCESS')] }, () => look())
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount(BAND)
  look = async () => {
    seen.push((await ui.findAll({ type: 'Text' })).map(one => one.text).join('|'))
    seen.push((await ui.find({ key })) === undefined ? 'no button' : 'button')
  }
  await ui.press({ key })
  await ui.press({ key })

  expect(merges.length).toBe(1)
  expect(seen[0]).toMatch(/◆ merging/)
  expect(seen[1]).toBe('no button')
})

test('after a merge the row leaves, though search still lists it as open', async ($, on) => {
  const clock = mock.clock(on)
  const key = 'merge-https://github.com/o/r/pull/1'
  gh(on, { nodes: [node(1, 'SUCCESS'), node(2, 'SUCCESS')] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount(BAND)
  await ui.press({ key })
  await ui.press({ key })
  await clock.advance(30_000)

  expect(await ui.find({ key })).toBeUndefined()
  expect(await ui.find({ key: 'merge-https://github.com/o/r/pull/2' })).toBeDefined()
})

test('a pull request behind its base gets Rebase instead of Merge, and one press rebases', async ($, on) => {
  const clock = mock.clock(on)
  const open = { nodes: [{ ...node(1, 'SUCCESS'), mergeStateStatus: 'BEHIND' }] }
  const runs = gh(on, open)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'merge-https://github.com/o/r/pull/1' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text).join('|')).toMatch(/needs rebase/)

  await ui.press({ key: 'rebase-https://github.com/o/r/pull/1' })
  expect(runs).toEqual([['gh', 'pr', 'update-branch', 'https://github.com/o/r/pull/1', '--rebase']])
})

test('a pull request with conflicts gets Resolve, which drafts the ask and runs nothing', async ($, on) => {
  const clock = mock.clock(on)
  const runs = gh(on, { nodes: [{ ...node(1, 'SUCCESS'), mergeStateStatus: 'DIRTY', headRefName: 'feat', baseRefName: 'main' }] })
  const drafts: string[] = []
  on('prompt.fill', (_, e) => {
    drafts.push(e.text)

    return { isFilled: true }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'merge-https://github.com/o/r/pull/1' })).toBeUndefined()
  expect(await ui.find({ key: 'rebase-https://github.com/o/r/pull/1' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text).join('|')).toMatch(/merge conflicts/)

  await ui.press({ key: 'resolve-https://github.com/o/r/pull/1' })
  expect(runs).toEqual([])
  expect(drafts.length).toBe(1)
  expect(drafts[0]).toContain('https://github.com/o/r/pull/1 (feat onto main)')
})

// What GitHub says of a pull request whose checks passed, and what its row says instead of Merge.
const HELD = {
  'needs approval': { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' },
  'changes requested': { reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' },
  'blocked by a branch rule': { reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED' },
}

for (const [status, fields] of Object.entries(HELD)) {
  test(`a pull request that GitHub holds says ${status}, with no Merge, here and in the checks tool`, async ($, on) => {
    const clock = mock.clock(on)
    on('tool.call', () => ({ result: '' }))
    gh(on, { nodes: [{ ...node(1, 'SUCCESS'), ...fields }] })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(30_000)

    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'merge-https://github.com/o/r/pull/1' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Text' })).map(one => one.text).join('|')).toContain(status)
    expect(String((await $.tool.call({ tool: 'mcp__gh-ci-status__checks' as const, tool_use_id: 't1' })).result)).toContain(status)
  })
}

test('a job held by a deployment protection rule says so instead of checks running', async ($, on) => {
  const clock = mock.clock(on)
  const pr = node(1, 'PENDING')
  pr.commits.nodes[0]!.commit.statusCheckRollup = {
    state: 'PENDING',
    contexts: { nodes: [{ name: 'deploy', status: 'WAITING', conclusion: null, detailsUrl: JOB } as never] },
  }
  gh(on, { nodes: [pr] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount(BAND)
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text).join('|')).toContain('awaiting deployment: deploy')
})

// What the pull request turned into between the first press and the second.
const CHANGED = {
  'it now needs approval': [{ ...node(1, 'SUCCESS'), reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }],
  'its checks went back to running': [node(1, 'PENDING')],
  'its head moved to a commit nobody pressed Merge on': [{ ...node(1, 'SUCCESS'), headRefOid: 'other' }],
  'it became a draft': [{ ...node(1, 'SUCCESS'), isDraft: true }],
  'it is no longer open': [],
  'its base moved on and it needs a rebase': [{ ...node(1, 'SUCCESS'), mergeStateStatus: 'BEHIND' }],
}

for (const [why, after] of Object.entries(CHANGED)) {
  test(`the second press does not merge when ${why}`, async ($, on) => {
    const clock = mock.clock(on)
    const open: { nodes: unknown[] } = { nodes: [node(1, 'SUCCESS')] }
    const merges = gh(on, open)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await clock.advance(30_000)

    const ui = await $.ui.mount(BAND)
    const key = 'merge-https://github.com/o/r/pull/1'
    await ui.press({ key })
    open.nodes = after
    await ui.press({ key })

    expect(merges).toEqual([])
  })
}

test('the repo column is as wide as the longest repo name, on every row', async ($, on) => {
  const clock = mock.clock(on)
  const long = 'owner/a-much-longer-name'
  gh(on, {
    nodes: [node(1, 'SUCCESS'), { ...node(2, 'PENDING'), repository: { nameWithOwner: long } }],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount(BAND)
  for (const n of [1, 2]) {
    const row = await ui.find({ key: `https://github.com/o/r/pull/${n}` })
    const repo = row?.children[0] as { props: { width: number }; children: [{ children: [string] }] }
    expect(repo.children[0].children[0]).toBe(n === 1 ? 'o/r' : long)
    expect(repo.props.width).toBe(long.length)
  }
})

// The harness holds the tree, not painted cells: this pins the props that make the terminal cut the name.
test('on a narrow terminal the repo name gives way, not the number or Merge', async ($, on) => {
  const clock = mock.clock(on)
  const long = 'owner/a-much-longer-name-than-the-band-is-wide'
  gh(on, { nodes: [{ ...node(1, 'SUCCESS'), repository: { nameWithOwner: long } }] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 20 } })
  const drawn = (await ui.drawn()) as unknown as { children: [{ props: object }] }
  expect(drawn.children[0].props).toMatchObject({ width: 20, borderStyle: 'round', borderColor: 'promptBorder' })

  const row = await ui.find({ key: 'https://github.com/o/r/pull/1' })
  const [repo, number, status, merge] = row?.children as [Cell, Cell, Cell, Cell]
  expect(repo.props).toMatchObject({ width: long.length, minWidth: 0, flexShrink: 1 })
  expect(repo.children[0].props).toMatchObject({ wrap: 'truncate-end' })
  expect(number.props).toMatchObject({ flexShrink: 0 })
  expect(merge.props).toMatchObject({ flexShrink: 0 })
  // Merge sits beside the status: nothing in the row grows to push it to the far edge.
  expect(status.props).not.toHaveProperty('flexGrow')
})

test('a failed pull request gets Fix, which drafts the ask and runs nothing', async ($, on) => {
  const clock = mock.clock(on)
  const runs = gh(on, { nodes: [{ ...node(1, 'FAILURE', 'lint'), headRefName: 'feat', baseRefName: 'main' }] })
  const drafts: string[] = []
  on('prompt.fill', (_, e) => {
    drafts.push(e.text)

    return { isFilled: true }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'fix-https://github.com/o/r/pull/1' })
  expect(runs).toEqual([])
  expect(drafts[0]).toContain('"lint" on https://github.com/o/r/pull/1 (feat onto main)')
  expect(drafts[0]).toContain('mcp__gh-ci-status__checks')
})

test('the checks tool answers one line per pull request, and the failing log tail for a url', async ($, on) => {
  const clock = mock.clock(on)
  const runs = gh(on, { nodes: [node(1, 'SUCCESS'), node(2, 'FAILURE', 'lint')] })
  on('tool.call', () => ({ result: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  const all = await $.tool.call({ tool: 'mcp__gh-ci-status__checks' as const, tool_use_id: 't1' })
  expect(all.result).toBe(
    'o/r #1: checks passed https://github.com/o/r/pull/1\no/r #2: checks failed (lint) https://github.com/o/r/pull/2',
  )
  expect(runs).toEqual([])

  const one = await $.tool.call({ tool: 'mcp__gh-ci-status__checks' as const, tool_use_id: 't2', url: 'https://github.com/o/r/pull/2' })
  expect(runs).toEqual([['gh', 'run', 'view', '--job', '99', '--log-failed', '-R', 'o/r']])
  expect(String(one.result)).toMatch(/^o\/r #2: checks failed \(lint\) \S+\n\nFailing log of job build:\n/)
  const log = String(one.result).split('Failing log of job build:\n')[1]?.split('\n') ?? []
  expect(log).toHaveLength(60)
  expect(log[0]).toBe('line 21')
  expect(log[59]).toBe('line 80')

  const stranger = await $.tool.call({ tool: 'mcp__gh-ci-status__checks' as const, tool_use_id: 't3', url: 'https://github.com/x/y/pull/9' })
  expect(String(stranger.result)).toMatch(/^Not one of the open pull requests/)
})

test('the checks tool says when gh failed, and does not pass an old list off as current', async ($, on) => {
  const clock = mock.clock(on)
  let isOnline = true
  on('process.run', async () => ({
    value: isOnline
      ? { ...OK, stdout: answer([{ ...node(1, 'SUCCESS'), mergeStateStatus: 'BEHIND' }]) }
      : { ...OK, exitCode: 1, stdout: '' },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  isOnline = false
  const got = await $.tool.call({ tool: 'mcp__gh-ci-status__checks' as const, tool_use_id: 't1' })
  // The checks show even when a rebase is what blocks the merge.
  expect(got.result).toBe('gh could not reach GitHub; last known state:\no/r #1: checks passed; needs rebase https://github.com/o/r/pull/1')
})

test('more pull requests than rows: the band keeps its budget and counts the rest', async ($, on) => {
  const clock = mock.clock(on)
  gh(on, { nodes: Array.from({ length: 12 }, (_, i) => node(i + 1, 'PENDING')) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  // maxRows 10: borders and heading leave seven rows, six pull requests and the count.
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'https://github.com/o/r/pull/6' })).toBeDefined()
  expect(await ui.find({ key: 'https://github.com/o/r/pull/7' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^\+ 6 more$/ })).toBeDefined()
})

test('the log comes from the failed Actions job, even after a failed external status', async ($, on) => {
  const clock = mock.clock(on)
  const pr = node(1, 'FAILURE')
  pr.commits.nodes[0]!.commit.statusCheckRollup = {
    state: 'FAILURE',
    contexts: {
      nodes: [
        { context: 'ci/external', state: 'FAILURE', targetUrl: 'https://ci.example.com/1' },
        { name: 'test', conclusion: 'FAILURE', detailsUrl: JOB },
      ],
    },
  } as never
  const runs = gh(on, { nodes: [pr] })
  on('tool.call', () => ({ result: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30_000)

  await $.tool.call({ tool: 'mcp__gh-ci-status__checks' as const, tool_use_id: 't1', url: 'https://github.com/o/r/pull/1' })
  expect(runs).toEqual([['gh', 'run', 'view', '--job', '99', '--log-failed', '-R', 'o/r']])
})
