import type { EngineInterface, Register } from 'claude-code'

import { invocations } from './shell'

const bin = (names: string) => new RegExp(String.raw`^(.*[\\/])?(${names})(\.exe|\.cmd|\.ps1)?$`, 'i')

// The bare words of a call: its subcommands and targets, without options or the values of the options listed.
const words = (args: readonly string[], valued = /(?!)/) =>
  args.filter((word, i) => !word.startsWith('-') && !valued.test(args[i - 1] ?? ''))

const GIT_VALUE = /^(-C|-c|--git-dir|--work-tree|--namespace|--config-env|--attr-source)$/
const PUSH_VALUE = /^(-o|--push-option|--repo|--receive-pack|--exec)$/
// A push that adds no commits to a branch: a delete, a dry run, a mirror; -d and -n also inside a group of short options.
const NO_COMMITS = /^(--delete|--dry-run|--mirror|-[a-zA-Z]*[dn][a-zA-Z]*)$/

// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
// shortcut: any other MCP tool that runs a command is not read; deny it by name in managed settings (permissions.deny) or add it here.

type Pr = { state: string; number: number; url: string; headRefOid: string }

// The branch's pull requests, or the reason GitHub could not be asked.
const pulls = async ($: EngineInterface, cwd: string, branch: string): Promise<Pr[] | string> => {
  try {
    const argv = ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'state,number,url,headRefOid', '--limit', '20']
    const got = await $.process.run(argv, { cwd, timeoutMs: 5_000 })
    const found: unknown = got.exitCode === 0 ? JSON.parse(got.stdout) : undefined

    return Array.isArray(found) ? (found as Pr[]) : got.stderr.trim().split('\n')[0] || `gh exited ${got.exitCode}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export const register: Register = on => {
  on('tool.call', { tool: SHELL_TOOLS }, async ($, e, next) => {
    // A Monitor that opens a WebSocket has no command.
    const command = String((e as { command?: unknown }).command ?? '')
    const notes: string[] = []
    // Fails open: this catches an agent's mistake, and must not stop work when GitHub or the repo cannot be asked.
    const unchecked = (branch: string, why: string) =>
      notes.push(`${$.plugin.name}: could not ask GitHub whether ${branch}'s PR is merged (${why.slice(0, 120)}); the push was not checked.`)
    // HEAD by any spelling; a blank is what "$(git branch --show-current)" leaves as the parser reads it.
    const isHead = (ref: string) => /^(HEAD|@)?$/.test(ref.trim())

    for (const args of invocations(command, bin('git'))) {
      const at = args.findIndex((word, i) => !word.startsWith('-') && !GIT_VALUE.test(args[i - 1] ?? ''))
      const rest = args.slice(at + 1)
      const [remote = 'origin', ...specs] = words(rest, PUSH_VALUE)

      if (args[at] !== 'push' || rest.some(arg => NO_COMMITS.test(arg)) || (rest.includes('--tags') && specs.length === 0)) {
        continue
      }

      // shortcut: the repo is the session's folder plus git's own -C options, a `cd` earlier in the command is not followed; follow the cds if pushes after a cd get missed.
      const cwd = await $.session.cwd().catch(() => undefined)

      if (cwd === undefined) {
        unchecked('the pushed branch', 'the session has no folder')
        continue
      }

      // Git Bash's /c/ as c:/, which the guard's own git and gh need on Windows.
      const dirs = args.slice(0, at).filter((_, i) => args[i - 1] === '-C').map(dir => dir.replace(/^\/([a-z])(?=\/|$)/i, '$1:'))
      const folder = dirs.reduce((from, dir) => (/^([\\/]|[a-z]:)/i.test(dir) ? dir : `${from}/${dir}`), cwd)
      // The call's result, exit code included; undefined when git could not run.
      const run = (...ask: string[]) =>
        $.process.run(['git', ...dirs.flatMap(dir => ['-C', dir]), ...ask], { cwd, timeoutMs: 5_000 }).catch(() => undefined)
      const git = async (...ask: string[]) => {
        const got = await run(...ask)

        return got?.exitCode === 0 ? got.stdout.trim() || undefined : undefined
      }

      for (const [i, spec] of (specs.length > 0 ? specs : ['HEAD']).entries()) {
        const bare = spec.replace(/^\+/, '')
        const dest = bare.slice(bare.indexOf(':') + 1).trim()

        // :branch deletes it, and a tag (refs/tags/v1, or `tag v1`) has no pull request.
        if (bare.startsWith(':') || dest.startsWith('refs/tags/') || spec === 'tag' || specs[i - 1] === 'tag') {
          continue
        }

        // A detached HEAD names no branch.
        const branch = isHead(dest) ? await git('symbolic-ref', '--short', '-q', 'HEAD') : dest.replace(/^refs\/heads\//, '')

        // The default branch is not asked about: gh's --head main would match a fork's pull request from its own main.
        if (branch === undefined || branch === 'main' || branch === 'master') {
          continue
        }

        const base = (await git('symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`))?.slice(remote.length + 1)

        if (branch === base) {
          continue
        }

        // shortcut: gh answers for the repo it resolves from the folder, so a push to another remote or a fork is still judged by that repo's pull requests; pass gh --repo from the remote's URL if that denies a fork push.
        const found = await pulls($, folder, branch)

        if (typeof found === 'string') {
          unchecked(branch, found)
          continue
        }

        const merged = found.find(one => one.state === 'MERGED')

        if (merged !== undefined && !found.some(one => one.state === 'OPEN')) {
          // A branch still on the remote was not deleted on merge: a long-lived one (develop merged into main), safe to push.
          const there = (await run('ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`))?.exitCode

          if (there !== 2) {
            if (there !== 0) {
              unchecked(branch, `git ls-remote ${remote} failed`)
            }

            continue
          }

          // The new commits sit on the refspec's source (local:feat/x), and HEAD moves on the switch, so it is named by branch or SHA.
          const from = bare.includes(':') ? bare.slice(0, bare.indexOf(':')) : branch
          const tip = isHead(from)
            ? ((await git('symbolic-ref', '--short', '-q', 'HEAD')) ?? (await git('rev-parse', 'HEAD')) ?? 'HEAD')
            : /^(HEAD|@)[~^]/.test(from)
              ? ((await git('rev-parse', from)) ?? from)
              : from

          // The merged head is not in what is pushed: another branch reusing the name. An error (the commit is not local) keeps the deny.
          if ((await run('merge-base', '--is-ancestor', merged.headRefOid, tip))?.exitCode === 1) {
            continue
          }

          return {
            deny: `${$.plugin.name}: ${branch}'s pull request is already merged (#${merged.number} ${merged.url}). Pushing recreates the branch GitHub deleted on merge and strands the commits outside any PR. Put them on a new branch instead: \`git fetch ${remote}\`, \`git switch -c ${branch}-followup ${remote}/${base ?? 'main'}\`, \`git cherry-pick ${merged.headRefOid}..${tip}\` (the commits made after the merge), \`git push -u ${remote} ${branch}-followup\`, then open a new PR.`,
          }
        }
      }
    }

    const done = await next(e)

    return notes.length === 0 || ('deny' in done && done.deny !== undefined) ? done : { ...done, context: [...(done.context ?? []), ...notes] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))
}
