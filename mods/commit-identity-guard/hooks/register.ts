import type { Register } from 'claude-code'

// `commit` as the subcommand, after any global options (-c key="a b", -C dir).
const COMMIT = /\bgit(?:\.exe)?((?:\s+(?:-[cC]\s+(?:"[^"]*"|'[^']*'|\S)+|--?[\w-]+(?:=\S+)?))*)\s+commit\b/
const PR = /\bgh(?:\.exe)?\s+pr\s+(create|edit)\b/
const TRAILER = /co-authored-by:[^\n]*(claude|anthropic)|generated with[^\n]*claude code/i
// GitHub owner names: letters, digits and hyphens, so one is safe inside a pattern.
const OWNER_NAME = /^[A-Za-z0-9-]+$/
const NOREPLY = /@users\.noreply\.github\.com$/i
// An identity given on the command itself, which wins over git config.
const AUTHOR = /--author[= ][^<\n]*<["']?([^\s"'<>]+@[^\s"'<>]+)/g
const SET_EMAIL = /(?:(?:user|author|committer)\.email=|GIT_(?:AUTHOR|COMMITTER)_EMAIL=)["']?([^\s"'<>]+@[^\s"'<>]+)/g
// The address in `git var GIT_AUTHOR_IDENT`'s "Name <address> time zone".
const IDENT_EMAIL = /<([^<>]*)>/
// shortcut: the repo is the session's folder unless git's global options name one (`-C <dir>`), the command starts with `cd <dir>`, or `gh` is given `-R <owner>/<repo>`; a message piped in (-F -) is not inspected, upgrade to a commit-msg hook in the repos if that gets used.
const GIT_DIR = /\s-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g
const CD = /(?:^|&&|;)\s*cd\s+["']?([^"';&|\n]+?)["']?\s*(?:&&|;|\n)/
// A message or body read from a file: git commit -F/--file, gh pr --body-file/-F.
// -F also takes its value attached: -Fmsg.txt.
const MESSAGE_FILE = /\s(?:-F(?:\s+|=)?|--file(?:\s+|=)|--body-file(?:\s+|=))(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g
const ABSOLUTE = /^([a-zA-Z]:)?[\\/]/

export const register: Register = on => {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const commit = COMMIT.exec(e.command)
    const isCommit = commit !== null

    if (!isCommit && !PR.test(e.command)) {
      return next(e)
    }

    // The owners whose repos the rules cover, comma-separated; none set, nothing is checked.
    const owners = ((await $.env.get('COMMIT_GUARD_OWNERS')) ?? '')
      .split(',')
      .map(one => one.trim())
      .filter(one => OWNER_NAME.test(one))

    if (owners.length === 0) {
      return next(e)
    }

    const any = owners.join('|')
    const origin = new RegExp(`github\\.com[:/](${any})/`, 'i')
    const ghRepo = new RegExp(`\\s(?:-R|--repo)[ =]["']?(?:https://github\\.com/)?(${any})/`, 'i')

    // -C counts only among git's global options: after `commit` it names a commit to reuse.
    // Git applies each -C on top of the last, so the cd and every -C go to it in order.
    const dirs = [
      CD.exec(e.command)?.[1],
      ...[...(commit?.[1] ?? '').matchAll(GIT_DIR)].map(([, a, b, c]) => a ?? b ?? c),
    ].flatMap(dir => (dir === undefined ? [] : ['-C', dir.replace(/^\/([a-zA-Z])\//, '$1:/')]))
    const git = async (...args: string[]) =>
      (await $.process.run(['git', ...dirs, ...args])).stdout.trim()

    const owner = ghRepo.exec(e.command)?.[1] ?? origin.exec(await git('remote', 'get-url', 'origin'))?.[1]

    if (owner === undefined) {
      return next(e)
    }

    // A message file is read where git and gh look for it: the cd and each -C in turn, an absolute one resetting the path.
    const base = dirs.filter((_, i) => i % 2 === 1).reduce((path, dir) => (ABSOLUTE.test(dir) || path === '' ? dir : `${path}/${dir}`), '')
    const files = [...e.command.matchAll(MESSAGE_FILE)]
      .map(([, a, b, c]) => (a ?? b ?? c ?? '').replace(/^\/([a-zA-Z])\//, '$1:/'))
      .filter(file => file !== '' && file !== '-')
      .map(file => (ABSOLUTE.test(file) || base === '' ? file : `${base}/${file}`))
    // An unreadable file passes: git or gh will fail on it themselves.
    const messages = await Promise.all(files.map(file => $.fs.read(file).then(String, () => '')))

    if (TRAILER.test(e.command) || messages.some(message => TRAILER.test(message))) {
      return { deny: `${$.plugin.name}: no Claude trailers in ${owner} repos. Remove the Co-Authored-By / Generated with Claude Code line and retry.` }
    }

    if (isCommit) {
      // Settings count up to `commit` only: after it comes the message, which sets nothing.
      const before = e.command.slice(0, commit?.index ?? 0)
      const inline = [
        ...e.command.matchAll(AUTHOR),
        ...`${before}${commit?.[0] ?? ''}`.matchAll(SET_EMAIL),
      ].map(([, email = '']) => email)
      // Git config still supplies an identity unless both are overridden: by `-c user.email=x` among git's own options, or by both variables set before the command.
      const isOverridden =
        /(^|\s)-c\s+["']?user\.email=\S/.test(commit?.[1] ?? '') ||
        (/GIT_AUTHOR_EMAIL=["']?[^\s"';]/.test(before) && /GIT_COMMITTER_EMAIL=["']?[^\s"';]/.test(before))
      // git var resolves what the commit would carry from config and the session: author.email and committer.email as well as user.email.
      const resolved = isOverridden
        ? []
        : await Promise.all(['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].map(async ident => IDENT_EMAIL.exec(await git('var', ident))?.[1]))
      const after = e.command.slice((commit?.index ?? 0) + (commit?.[0].length ?? 0))
      // An amend keeps the old author unless told otherwise, and with --no-edit the old message too.
      const amended = /\s--amend\b/.test(after) ? (await git('log', '-1', '--format=%ae%n%B')).split('\n') : undefined
      const keptAuthor = amended !== undefined && !/\s--(reset-author|author)\b/.test(after) ? [amended[0] ?? ''] : []

      if (amended !== undefined && /\s--no-edit\b/.test(after) && TRAILER.test(amended.slice(1).join('\n'))) {
        return { deny: `${$.plugin.name}: the commit being amended carries a Claude trailer. Amend with a message without it.` }
      }

      const emails = [...inline, ...resolved.filter((one): one is string => one !== undefined), ...keptAuthor]
      const wrong = emails.find(email => !NOREPLY.test(email))

      if (wrong !== undefined) {
        return { deny: `${$.plugin.name}: this commit would carry the address "${wrong}" as author or committer. ${owner} repos take the GitHub noreply address only.` }
      }
    }

    return next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
