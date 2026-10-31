import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Desktop draws no status line, so there the same items show above the prompt.
const left = atom({ plugin: 'cleanup-check', key: 'left' } as const, [] as string[])

// Saved Terraform plans: tfplan, gd.tfplan, prod-tfplan.out.
const PLAN_FILE = /(^|\/)[^/]*tfplan[^/]*$/i

export type Repo = {
  // Empty on a detached HEAD.
  current: string
  base: string
  // Local branches git sees merged into the base: a new branch with no commits of its own is one too.
  merged: readonly string[]
  // Local branches whose remote branch was deleted: what a squash merge with --delete-branch leaves.
  gone: readonly string[]
  // Local branches pushed under their own name: an upstream of origin/main does not count.
  pushed: readonly string[]
  // Local branches checked out in another worktree: not this one's to delete.
  elsewhere: readonly string[]
  untracked: readonly string[]
}

/** What is left to clean up, one short item each. */
export const leftovers = ({ current, base, merged, gone, pushed, elsewhere, untracked }: Repo): string[] => {
  // Merged: pushed, and in the base's history; a branch just made from the base is not.
  const isMerged = (branch: string) => merged.includes(branch) && pushed.includes(branch)
  // Its remote is gone: a squash merge with --delete-branch leaves that, but so does deleting it unmerged, so it is not called merged.
  const isGone = (branch: string) => gone.includes(branch) && !isMerged(branch)
  const isOther = (one: string) => one !== base && one !== current && !elsewhere.includes(one)
  const done = merged.filter(one => isOther(one) && isMerged(one))
  const orphans = gone.filter(one => isOther(one) && isGone(one))
  const plans = untracked.filter(one => PLAN_FILE.test(one))
  const isCurrent = current !== '' && current !== base

  return [
    ...(isCurrent && isMerged(current) ? [`${current} is merged: switch to ${base} and pull`] : []),
    ...(isCurrent && isGone(current) ? [`${current}'s remote branch is gone: if it was merged, switch to ${base} and pull`] : []),
    ...(done.length > 0 ? [`${done.length} merged branch${done.length > 1 ? 'es' : ''} to delete: ${done.join(', ')}`] : []),
    ...(orphans.length > 0
      ? [`${orphans.length} branch${orphans.length > 1 ? 'es' : ''} whose remote is gone, delete if merged: ${orphans.join(', ')}`]
      : []),
    ...(plans.length > 0 ? [`${plans.length} saved plan${plans.length > 1 ? 's' : ''}: ${plans.join(', ')}`] : []),
  ]
}

const git = async ($: EngineInterface, cwd: string, args: readonly string[]) => {
  try {
    const got = await $.process.run(['git', ...args], { cwd, timeoutMs: 10_000 })

    return got.exitCode === 0 ? got.stdout : undefined
  } catch {
    return undefined
  }
}

const lines = (text: string | undefined) => (text ?? '').split('\n').map(one => one.trim()).filter(Boolean)
const paths = (text: string | undefined) => (text ?? '').split('\0').filter(Boolean)

// shortcut: reads refs as they are, with no fetch, so a branch merged on GitHub shows once something fetches with --prune; fetch here if that lag bites.
const look = async ($: EngineInterface): Promise<Repo | undefined> => {
  const root = (await git($, await $.session.cwd(), ['rev-parse', '--show-toplevel']))?.trim()

  if (root === undefined) {
    return undefined
  }

  // A detached HEAD has no branch to judge, but its plans still count.
  const head = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  const current = head === undefined || head === 'HEAD' ? '' : head
  const remoteHead = (await git($, root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim()
  const base = remoteHead?.replace(/^origin\//, '') ?? 'main'
  const merged = lines(await git($, root, ['branch', '--merged', remoteHead ?? base, '--format=%(refname:short)']))
  // name|upstream|track|worktree, e.g. "feat|refs/remotes/origin/feat|[gone]|".
  const refs = lines(
    await git($, root, ['for-each-ref', '--format=%(refname:short)|%(upstream)|%(upstream:track)|%(worktreepath)', 'refs/heads']),
  ).map(one => one.split('|'))
  // From the root, NUL-separated: untracked files one by one (inside new folders too), ignored ones with folders like .terraform/ as one entry.
  const untracked = [
    ...paths(await git($, root, ['ls-files', '-z', '--others', '--exclude-standard'])),
    ...paths(await git($, root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])),
  ]
  const isRoot = (path: string | undefined) => (path ?? '').replace(/\\/g, '/').toLowerCase() === root.replace(/\\/g, '/').toLowerCase()

  return {
    current,
    base,
    merged,
    gone: refs.filter(([, , track]) => track === '[gone]').map(([name]) => name ?? ''),
    pushed: refs.filter(([name, upstream]) => name !== undefined && upstream?.endsWith(`/${name}`)).map(([name]) => name ?? ''),
    elsewhere: refs.filter(([, , , tree]) => tree !== undefined && tree !== '' && !isRoot(tree)).map(([name]) => name ?? ''),
    untracked,
  }
}

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ends inside the main one: the main turn's end is when the person looks.
    if (e.agentId !== undefined) {
      return next(e)
    }

    const repo = await look($)
    const items = repo === undefined ? [] : leftovers(repo)

    $.ui.status(items.length === 0 ? undefined : `Cleanup: ${items.join(' · ')}`)
    await update($, left, () => items)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const items = await read($, left)
    if (e.surface !== 'desktop' || e.props.hasSurvey || items.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box columnGap={1} flexWrap="wrap">
          <Text weight="semibold">Cleanup</Text>
          <Text dimColor>{items.join(' · ')}</Text>
        </Box>
        {await next(e)}
      </Box>
    )
  })
}
