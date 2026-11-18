import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Desktop draws no status line, so there the same items show above the prompt.
const left = atom({ plugin: 'cleanup-check', key: 'left' } as const, [] as string[])

// Saved Terraform plans: tfplan, gd.tfplan, prod-tfplan.out.
const PLAN_FILE = /(^|\/)[^/]*tfplan[^/]*$/i

// Keys, certificates, keystores, SSH keys, .env files, Terraform state and cloud credential files, by file name.
// shortcut: an ignored folder (secrets/) comes from git as one entry, so files inside it go unseen; list ignored files one by one if that matters.
const SECRET_FILE =
  /(^|\/)([^/]+\.(pem|key|p12|pfx|jks|keystore|crt|cer|ppk|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|\.env(\.[^/]+)?|[^/]*\.tfstate(\.[^/]+)?|(application_default_)?credentials(\.json)?)$/i
// Templates with no real values: .env.example, .env.example.local.
const SECRET_TEMPLATE = /\.(example|sample|template|dist)(\.[^/]*)?$/i

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
  const secrets = untracked.filter(one => SECRET_FILE.test(one) && !SECRET_TEMPLATE.test(one))
  const isCurrent = current !== '' && current !== base

  return [
    ...(isCurrent && isMerged(current) ? [`${current} is merged: switch to ${base} and pull`] : []),
    ...(isCurrent && isGone(current) ? [`${current}'s remote branch is gone: if it was merged, switch to ${base} and pull`] : []),
    ...(done.length > 0 ? [`${done.length} merged branch${done.length > 1 ? 'es' : ''} to delete: ${done.join(', ')}`] : []),
    ...(orphans.length > 0
      ? [`${orphans.length} branch${orphans.length > 1 ? 'es' : ''} whose remote is gone, delete if merged: ${orphans.join(', ')}`]
      : []),
    ...(plans.length > 0 ? [`${plans.length} saved plan${plans.length > 1 ? 's' : ''}: ${plans.join(', ')}`] : []),
    ...(secrets.length > 0
      ? [`${secrets.length} key, cert or secret file${secrets.length > 1 ? 's' : ''} to delete or move out: ${secrets.join(', ')}`]
      : []),
  ]
}

// A folder name safe to join into a path: no separators, not . or ..
const NAME = /^(?!\.{1,2}$)[\w.+-]+$/
// A plugin updated less than a day ago keeps its old copies: a session started before the update may still run from one.
const GRACE_MS = 24 * 60 * 60 * 1000

// One entry of installed_plugins.json's `plugins`, keyed "name@marketplace"; a plugin installed in several scopes has several.
export type Install = { installPath?: string; lastUpdated?: string }
export type PluginCache = { dir: string; keep: readonly string[] }

// One spelling per folder: C:\a\\b\ and c:/a/b match, so a doubled or trailing separator never makes a version in use look unused.
// Case folds only on a drive path: on Linux /m/P and /m/p are two folders, and a link from one to the other must not pass as itself.
// shortcut: an 8.3 short name (DUSTIN~1) never equals its long name, so such a plugin is skipped, not pruned; expand names if that bites.
export const same = (path: string) => {
  const one = path.replace(/[\\/]+/g, '/').replace(/\/$/, '')

  return /^[A-Za-z]:\//.test(one) ? one.toLowerCase() : one
}

/** Each plugin's cache folder whose old versions may go, with the versions in use to keep. */
export const prunable = (cache: string, plugins: Readonly<Record<string, readonly Install[]>>, now: number): PluginCache[] =>
  Object.entries(plugins).flatMap(([key, installs]) => {
    const [name, market, ...rest] = key.split('@')
    const sep = cache.includes('\\') ? '\\' : '/'
    const dir = `${cache}${sep}${market}${sep}${name}`
    const keep = installs.map(one => one.installPath ?? '')
    // A version in use is a folder right under the plugin's: a deeper path would leave its version folder looking unused.
    const isVersion = (path: string) => same(path).startsWith(`${same(dir)}/`) && NAME.test(same(path).slice(same(dir).length + 1))
    const updated = installs.map(one => Date.parse(one.lastUpdated ?? ''))
    // Unsure what is in use, or a copy not under this folder (a local install): leave it all.
    const isKnown =
      rest.length === 0 &&
      [name, market].every(one => one !== undefined && NAME.test(one)) &&
      installs.length > 0 &&
      keep.every(isVersion) &&
      updated.every(one => !Number.isNaN(one) && now - one >= GRACE_MS)

    return isKnown ? [{ dir, keep }] : []
  })

/** The version folders under a plugin's cache folder that no install uses. */
export const oldCopies = ({ dir, keep }: PluginCache, versions: readonly string[]): string[] => {
  const sep = dir.includes('\\') ? '\\' : '/'
  const kept = keep.map(same)

  return versions.filter(one => NAME.test(one)).map(one => `${dir}${sep}${one}`).filter(one => !kept.includes(same(one)))
}

// Counts the old copies, and deletes them only when `remove` is set.
// shortcut: no grace for a session left open over a day across an update; its skills from the old copy fail until it restarts.
const pruneCache = async ($: EngineInterface, remove: boolean) => {
  // `||`, not `??`: an empty variable is unset, not the filesystem root.
  const raw =
    (await $.env.get('CLAUDE_CONFIG_DIR')) || (await $.env.get('USERPROFILE'))?.concat('\\.claude') || (await $.env.get('HOME'))?.concat('/.claude')
  const isWindows = /^[A-Za-z]:[\\/]/.test(raw ?? '')
  // Windows gets backslashes throughout, since rd reads a forward slash as a switch.
  const home = isWindows ? raw?.replace(/\//g, '\\').replace(/\\+$/, '') : raw?.replace(/\/+$/, '')

  // Absolute only, and nothing cmd.exe would read as an operator or variable.
  if (home === undefined || !(isWindows || home.startsWith('/')) || /[&|<>^%!"\r\n]/.test(home)) {
    return 0
  }

  const sep = isWindows ? '\\' : '/'
  const installed = await $.fs
    .read(`${home}${sep}plugins${sep}installed_plugins.json`)
    .then(text => JSON.parse(text) as { plugins?: Record<string, Install[]> })
    .catch(() => undefined)
  let count = 0

  for (const plugin of prunable(`${home}${sep}plugins${sep}cache`, installed?.plugins ?? {}, Date.now())) {
    // A link or junction anywhere on the way would send the deletes somewhere else: the folder must resolve to itself.
    const real = (await $.fs.stat(plugin.dir, { resolve: true }).catch(() => undefined))?.realPath
    if (real === undefined || same(real) !== same(plugin.dir)) {
      continue
    }

    const entries = await $.fs.list(plugin.dir).catch(() => [])
    const versions = entries.filter(one => one.kind === 'dir' && !one.isLink).map(one => one.name)

    for (const path of oldCopies(plugin, versions)) {
      if (!remove) {
        count += 1
        continue
      }
      const argv = isWindows ? ['cmd', '/d', '/c', 'rd', '/s', '/q', path] : ['rm', '-rf', '--', path]
      const done = await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => undefined)

      count += done?.exitCode === 0 ? 1 : 0
    }
  }

  return count
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

// Deleting branches and secret files needs judgment: the button only drafts the ask, the person reads it and sends it.
const cleanUp =($: EngineInterface, items: readonly string[]) =>
  $.prompt.fill({
    text: `Clean up what cleanup-check lists: ${items.join('; ')}. Delete merged branches with git branch -d, never -D. For a branch whose remote is gone, check it was merged first and ask me about any that was not. Ask me before deleting or moving any saved plan, key, cert or secret file. Then tell me what you removed.`,
  })

export const register: Register = on => {
  // Plugin updates leave the old versions in the cache; count them once a session, off the startup path,
  // and delete them only when the person opted in: a reminder mod does not delete on its own.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const remove = (await $.env.get('CLEANUP_CHECK_PRUNE_CACHE')) === '1'
    const copies = (n: number) => `${n} old plugin cop${n > 1 ? 'ies' : 'y'}`

    void pruneCache($, remove)
      .then(
        n =>
          n > 0 &&
          $.ui.toast(
            remove
              ? `Cleanup: removed ${copies(n)}`
              : `Cleanup: ${copies(n)} in the plugin cache; set CLEANUP_CHECK_PRUNE_CACHE=1 to remove them at session start`,
          ),
      )
      .catch(() => undefined)

    return started
  })

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

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box columnGap={1} flexWrap="wrap">
          <Text weight="semibold">Cleanup</Text>
          <Text dimColor>{items.join(' · ')}</Text>
          <Button key="clean-up" label="Clean up" onPress={() => cleanUp($, items)} />
        </Box>
        {await next(e)}
      </Box>
    )
  })
}
