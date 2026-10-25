import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pr } from '../types'

const POLL_MS = 30_000
const CHECKS_TOOL = 'mcp__gh-ci-status__checks'
// Theme keys, so the band follows the person's light or dark theme.
const BORDER = 'promptBorder'
const ON_BUTTON = 'inverseText'
// Lines of a failing log the model reads: the error is almost always at the end.
const LOG_LINES = 60
const LINE_CHARS = 300
// The person's own pull requests, and Dependabot's on the repositories the person owns.
// shortcut: the 20 most recently updated of each, paginate if more are ever open at once.
const QUERY = `{
  mine: search(type: ISSUE, first: 20, query: "is:pr is:open author:@me sort:updated-desc") { ...prs }
  bots: search(type: ISSUE, first: 20, query: "is:pr is:open author:app/dependabot user:@me archived:false sort:updated-desc") { ...prs }
}
fragment prs on SearchResultItemConnection { nodes { ... on PullRequest {
  number url isDraft updatedAt headRefOid headRefName baseRefName mergeStateStatus repository { nameWithOwner }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 50) { nodes {
    ... on CheckRun { name conclusion detailsUrl } ... on StatusContext { context state targetUrl }
  } } } } } }
} } }`
const ACTIONS_JOB = /\/actions\/runs\/\d+\/job\/(\d+)/
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']

const prs = atom({ plugin: 'gh-ci-status', key: 'prs' } as const, [])
// The pull request and head commit whose Merge button was pressed once; the second press merges.
const armed = atom({ plugin: 'gh-ci-status', key: 'armed' } as const, '')
// The url of the pull request being merged right now.
const merging = atom({ plugin: 'gh-ci-status', key: 'merging' } as const, '')
// The url of the pull request being rebased right now.
const rebasing = atom({ plugin: 'gh-ci-status', key: 'rebasing' } as const, '')
// Urls this session merged: search still lists a pull request as open for a while after its merge.
const merged = atom({ plugin: 'gh-ci-status', key: 'merged' } as const, [])

const toPr = (node: any): Pr => {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup
  const state: string = rollup?.state ?? ''
  const failed = (rollup?.contexts?.nodes ?? []).filter((one: any) => FAILED.includes(one.conclusion ?? one.state))
  const bad = failed[0]
  // The log comes from the first failed Actions job, which an external status before it must not hide.
  const job = failed.find((one: any) => ACTIONS_JOB.test(one.detailsUrl ?? '')) ?? bad

  return {
    url: node.url,
    repo: node.repository.nameWithOwner,
    number: node.number,
    sha: node.headRefOid,
    isDraft: node.isDraft,
    // No checks at all is not a pass: nothing failed because nothing ran.
    checks:
      state === ''
        ? 'none'
        : state === 'SUCCESS'
          ? 'passed'
          : FAILED.includes(state)
            ? 'failed'
            : 'pending',
    failing: bad?.name ?? bad?.context ?? '',
    failingUrl: job?.detailsUrl ?? job?.targetUrl ?? '',
    behind: node.mergeStateStatus === 'BEHIND',
    conflicts: node.mergeStateStatus === 'DIRTY',
    branch: `${node.headRefName} onto ${node.baseRefName}`,
  }
}

// A failed fetch (offline, gh signed out) keeps the last list and answers null.
const refresh = async ($: EngineInterface): Promise<Pr[] | null> => {
  try {
    const got = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${QUERY}`])

    if (got.exitCode !== 0) {
      return null
    }

    const { mine, bots } = JSON.parse(got.stdout).data
    const gone = await read($, merged)
    const list: Pr[] = [...mine.nodes, ...bots.nodes]
      .filter(node => !gone.includes(node.url))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .map(toPr)
    await update($, prs, () => list)

    return list
  } catch {
    return null
  }
}

// What the band says: the one thing that blocks the merge, else the checks.
const statusOf = (pr: Pr) =>
  pr.conflicts && !pr.isDraft
    ? 'merge conflicts'
    : pr.behind && !pr.isDraft
      ? 'needs rebase'
      : pr.checks === 'passed'
        ? 'checks passed'
        : pr.checks === 'pending'
          ? 'checks running'
          : pr.checks === 'failed'
            ? `failed: ${pr.failing || 'checks'}`
            : 'no checks'

// What the model reads: the checks always, and what else stands in the way of a merge.
const summaryOf = (pr: Pr) => {
  const checks = pr.checks === 'failed' ? `failed (${pr.failing || 'checks'})` : pr.checks === 'pending' ? 'running' : pr.checks
  const blocks = [pr.isDraft && 'draft', pr.conflicts && 'merge conflicts', pr.behind && 'needs rebase'].filter(Boolean)

  return `${pr.repo} #${pr.number}: checks ${checks}${blocks.length > 0 ? `; ${blocks.join(', ')}` : ''} ${pr.url}`
}

// The tail of the failing Actions job's log, each line without its job, step and timestamp columns.
const failedLog = async ($: EngineInterface, pr: Pr): Promise<string> => {
  const job = pr.failingUrl.match(ACTIONS_JOB)?.[1]

  if (!job) {
    return pr.failingUrl === '' ? 'No log: the failing check has no page.' : `No Actions log; see ${pr.failingUrl}`
  }

  try {
    const got = await $.process.run(['gh', 'run', 'view', '--job', job, '--log-failed', '-R', pr.repo], {
      timeoutMs: 60_000,
    })

    if (got.exitCode !== 0) {
      return `No log: ${got.stderr.trim().split('\n').pop()}`
    }

    const lines = got.stdout.trimEnd().split('\n').slice(-LOG_LINES)
    const name = lines.at(-1)?.split('\t')[0] ?? ''
    // shortcut: past 4 MiB the run keeps the start, so the tail is from the middle; stream it if that ever matters.
    const cut = got.isStdoutTruncated ? ' (log over 4 MiB: these lines are not its end)' : ''

    return [
      `Failing log of job ${name}${cut}:`,
      ...lines.map(line => line.split('\t').slice(2).join('\t').replace(/^\S+Z /, '').slice(0, LINE_CHARS)),
    ].join('\n')
  } catch {
    return 'No log: gh did not answer.'
  }
}

const idOf = (pr: Pr) => `${pr.url}@${pr.sha}`

const press = async ($: EngineInterface, pr: Pr) => {
  if ((await read($, armed)) !== idOf(pr)) {
    await update($, armed, () => idOf(pr))

    return
  }

  await update($, armed, () => '')
  // The row says so from here until it leaves: the button does not come back in between.
  await update($, merging, () => pr.url)

  try {
    // The band can be 30 s old: look again before merging.
    const now = (await refresh($))?.find(one => one.url === pr.url)

    if (now?.checks !== 'passed' || now.sha !== pr.sha || now.isDraft) {
      $.ui.toast(`${pr.repo} #${pr.number} not merged: its checks are no longer passing`)

      return
    }

    if (now.behind) {
      $.ui.toast(`${pr.repo} #${pr.number} not merged: it needs a rebase first`)

      return
    }

    const done = await $.process.run(
      ['gh', 'pr', 'merge', pr.url, '--squash', '--delete-branch', '--match-head-commit', pr.sha],
      { timeoutMs: 60_000 },
    )
    if (done.exitCode === 0) {
      // A merged pull request never reopens, so the url stays out for the session.
      await update($, merged, gone => [...gone, pr.url])
    }
    $.ui.toast(
      done.exitCode === 0
        ? `Merged ${pr.repo} #${pr.number}`
        : `${pr.repo} #${pr.number} not merged: ${done.stderr.trim().split('\n').pop()}`,
    )
  } catch {
    // gh did not start or ran past the timeout: the merge may or may not have happened.
    $.ui.toast(`${pr.repo} #${pr.number}: gh did not answer, check the pull request`)
  } finally {
    await refresh($)
    await update($, merging, () => '')
  }
}

// One press, like GitHub's own Update branch: the rebase only moves the branch, nothing merges.
const rebase = async ($: EngineInterface, pr: Pr) => {
  await update($, rebasing, () => pr.url)

  try {
    const done = await $.process.run(['gh', 'pr', 'update-branch', pr.url, '--rebase'], {
      timeoutMs: 60_000,
    })
    $.ui.toast(
      done.exitCode === 0
        ? `Rebased ${pr.repo} #${pr.number}: checks run again before it can merge`
        : `${pr.repo} #${pr.number} not rebased: ${done.stderr.trim().split('\n').pop()}`,
    )
  } catch {
    $.ui.toast(`${pr.repo} #${pr.number}: gh did not answer, check the pull request`)
  } finally {
    await refresh($)
    await update($, rebasing, () => '')
  }
}

// Conflicts and failures need judgment: the buttons only draft the ask, the person reads it and sends it.
const resolve = ($: EngineInterface, pr: Pr) =>
  $.prompt.fill({
    text: `Resolve the merge conflicts in ${pr.url} (${pr.branch}): rebase it on its base, fix the conflicts, run its checks, and show me the resolution before you push.`,
  })

const fix = ($: EngineInterface, pr: Pr) =>
  $.prompt.fill({
    text: `Fix the failing check ${pr.failing ? `"${pr.failing}" ` : ''}on ${pr.url} (${pr.branch}): read its log with ${CHECKS_TOOL} and this url, fix the cause, run it locally if you can, and show me the change before you push.`,
  })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // State outlives a reload: a press from before it must not count.
    void update($, armed, () => '')
    void update($, merging, () => '')
    void update($, rebasing, () => '')
    void refresh($)
    $.clock.every(POLL_MS, () => {
      void update($, armed, () => '')
      void refresh($)
    })
    await $.tool.register({
      name: 'checks',
      description:
        "CI state of the user's open pull requests, one line each. With a pull request url, also the tail of its failing GitHub Actions log. Use instead of gh pr checks or gh run view.",
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'A pull request url, for its failing log.' } },
      },
    })

    return next(e)
  })

  on('tool.call', { tool: CHECKS_TOOL }, async ($, e) => {
    const fresh = await refresh($)
    const list = fresh ?? (await read($, prs))
    // A failed fetch says so: an old list must not pass for the current one.
    const stale = fresh === null ? 'gh could not reach GitHub; last known state:\n' : ''
    const url = typeof e.url === 'string' ? e.url.trim() : ''
    const pr = list.find(one => one.url === url)

    if (fresh === null && list.length === 0) {
      return { result: 'gh could not reach GitHub, and there is no earlier state.' }
    }

    if (url !== '' && !pr) {
      return { result: `${stale}Not one of the open pull requests:\n${list.map(summaryOf).join('\n')}` }
    }

    // One pull request asked for: its line, and its log when it failed.
    if (pr) {
      return { result: `${stale}${summaryOf(pr)}${pr.checks === 'failed' ? `\n\n${await failedLog($, pr)}` : ''}` }
    }

    return { result: list.length === 0 ? 'No open pull requests.' : `${stale}${list.map(summaryOf).join('\n')}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, prs)
    // The band's own rows: two borders and the heading.
    const room = e.props.maxRows - 3

    if (e.props.hasSurvey || list.length === 0 || room < 1) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const waiting = await read($, armed)
    const inFlight = await read($, merging)
    const moving = await read($, rebasing)
    // Past the row budget, the last row counts the rest.
    const shown = list.length > room ? list.slice(0, room - 1) : list
    // as wide as the longest repo name, so the # column lines up without a gap
    const repoWidth = Math.max(...shown.map(pr => pr.repo.length))
    const button = (key: string, label: string, color: string, onPress: () => unknown) => (
      <Box flexShrink={0}>
        <Button key={key} plain onPress={onPress}>
          <Text bold color={ON_BUTTON} backgroundColor={color}>
            {` ${label} `}
          </Text>
        </Button>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {/* the Box holding next(e) may not set width, so the rows get a sized Box of their own */}
        <Box
          flexDirection="column"
          width={e.props.bodyColumns}
          borderStyle="round"
          borderColor={BORDER}
          paddingX={1}
        >
          <Box columnGap={1}>
            <Text bold wrap="truncate-end">
              Pull requests
            </Text>
            <Text dimColor>{`· ${list.length} open`}</Text>
          </Box>
          {shown.map(pr => {
            const isMerging = inFlight === pr.url
            const isRebasing = moving === pr.url
            const isBusy = isMerging || isRebasing
            const isConfirming = waiting === idOf(pr)
            const status = statusOf(pr)
            const [mark, color] = isMerging
              ? (['◆', 'merged'] as const)
              : isRebasing
                ? (['◆', 'warning'] as const)
              : status === 'merge conflicts'
                ? (['×', 'error'] as const)
              : status === 'needs rebase'
                ? (['↻', 'warning'] as const)
              : pr.checks === 'passed'
                ? (['✓', 'success'] as const)
                : pr.checks === 'pending'
                  ? (['●', 'warning'] as const)
                  : pr.checks === 'failed'
                    ? (['×', 'error'] as const)
                    : (['○', 'inactive'] as const)
            const shownStatus = isMerging ? 'merging' : isRebasing ? 'rebasing' : status

            return (
              <Box key={pr.url} columnGap={1} flexWrap="nowrap">
                <Box width={repoWidth} minWidth={0} flexShrink={1}>
                  <Text dimColor wrap="truncate-end">
                    {pr.repo}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text bold>{`#${pr.number}`}</Text>
                </Box>
                {/* Not grown: Merge sits beside the status, not at the far edge. */}
                <Box flexShrink={1} minWidth={0}>
                  <Text color={color} wrap="truncate-end">
                    {`${pr.isDraft && !isMerging ? '◇ draft · ' : `${mark} `}${shownStatus}`}
                  </Text>
                </Box>
                {!isBusy && pr.conflicts && !pr.isDraft && button(`resolve-${pr.url}`, 'Resolve', 'error', () => resolve($, pr))}
                {!isBusy && pr.behind && !pr.isDraft && button(`rebase-${pr.url}`, 'Rebase', 'warning', () => rebase($, pr))}
                {!isBusy && !pr.conflicts && !pr.behind && pr.checks === 'failed' && button(`fix-${pr.url}`, 'Fix', 'error', () => fix($, pr))}
                {!isBusy && !pr.behind && !pr.conflicts && pr.checks === 'passed' && !pr.isDraft &&
                  button(
                    `merge-${pr.url}`,
                    isConfirming ? 'Press again to merge' : 'Merge',
                    isConfirming ? 'warning' : 'success',
                    () => press($, pr),
                  )}
              </Box>
            )
          })}
          {shown.length < list.length && <Text dimColor>{`+ ${list.length - shown.length} more`}</Text>}
        </Box>
        {await next(e)}
      </Box>
    )
  })
}
