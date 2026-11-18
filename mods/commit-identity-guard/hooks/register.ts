import type { Register } from 'claude-code'

const r = String.raw
// A word as the shell still reads it, with quotes, a backslash or a PowerShell backtick between its letters: c""ommit, comm\it.
const loose = (word: string) => [...word].join('["\'\\\\`]*')
// `commit` as the subcommand, after any global options (-c key="a b", -C dir, --work-tree dir), in any case (Windows runs GIT).
const COMMIT = new RegExp(
  r`\b${loose('git')}(?:\.exe)?["']?((?:\s+(?:(?:-[cC]|--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source))\s+(?:"[^"]*"|'[^']*'|\S)+|--?[\w-]+(?:=\S+)?))*)\s+["']?${loose('commit')}\b`,
  'i',
)
// gh's own options can stand before `pr` (gh -R o/r pr create), and a merge writes the squash commit's message.
const PR = /\bgh(?:\.exe)?\s(?:[^|;&\n]*?\s)?pr\s+(create|edit|merge)\b/i
// --trailer also takes key=value.
const TRAILER = /co-authored-by\s*[:=][^\n]*(claude|anthropic)|generated with[^\n]*claude code/i
// GitHub owner names: letters, digits and hyphens, so one is safe inside a pattern.
const OWNER_NAME = /^[A-Za-z0-9-]+$/
const NOREPLY = /@users\.noreply\.github\.com$/i
// An identity given on the command itself, which wins over git config. Git takes a long option by any unambiguous prefix (--auth),
// and an --author with no <address> picks one from the log.
const AUTHOR = /^--au\w*(?:=(.*))?$/s
// A word with its quoted runs kept whole, so an option named inside a message is not one.
const WORD = /(?:"[^"]*"|'[^']*'|[^\s"'])+/g
// Read with quotes dropped: -c user.email=x in any case, git config user.email x, VAR=x, $env:VAR = 'x', SetEnvironmentVariable('VAR', 'x').
const SET_EMAIL = /(?:(?:user|author|committer)\.email(?:=|[ \t]+)|GIT_(?:AUTHOR|COMMITTER)_EMAIL\s*[=,]\s*)([^\s<>;&|,)]+)/gi
// Config the guard's own git calls would not see.
const UNREAD = /(?<![\w.])(GIT_CONFIG\w*|HOME|XDG_CONFIG_HOME|EMAIL)\s*[=,]|--config-env\b|\b[Ii]nclude(?:[Ii]f)?\.\S*path=/
// gh pr merge -A sets the merge commit's author.
const MERGE_AS = /\s(?:-A|--author-email)[ =]?(\S+)/
const INSIDE = /["'\\`]/g
const emptied = (text: string) => text.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""')
// The address in `git var GIT_AUTHOR_IDENT`'s "Name <address> time zone".
const IDENT_EMAIL = /<([^<>]*)>/
// shortcut: the repo is the session's folder unless git's global options name one (`-C <dir>`), the command starts with `cd <dir>`, or `gh` is given `-R <owner>/<repo>`; a message piped in (-F -) is not inspected, upgrade to a commit-msg hook in the repos if that gets used.
const GIT_DIR = /\s-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g
const CD = /(?:^|&&|;)\s*cd\s+["']?([^"';&|\n]+?)["']?\s*(?:&&|;|\n)/
// A message or body read from a file: git commit -F/--file, gh pr --body-file/-F.
// -F also takes its value attached (-Fmsg.txt) and joins other short options (-aF msg.txt); --file can be cut short.
const MESSAGE_FILE = /\s(?:-[a-zA-Z]*F(?:\s+|=)?|--fil\w*(?:\s+|=)|--body-file(?:\s+|=))(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g
const ABSOLUTE = /^([a-zA-Z]:)?[\\/]/
// After `commit`, -C or --reuse-message names a commit whose message and author are reused; -c and --reedit-message open it in the editor first.
const REUSE = /\s(?:-[cC]|--re[ue]\w*)(?:\s+|=)?(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))/

// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
// shortcut: any other MCP tool that runs a command is not read; deny it by name in managed settings (permissions.deny) or add it here.

export const register: Register = on => {
  on('tool.call', { tool: SHELL_TOOLS }, async ($, e, next) => {
    // A Monitor that opens a WebSocket has no command. Line continuations join, as the shell joins them.
    const command = String((e as { command?: unknown }).command ?? '').replace(/\\\r?\n/g, '').replace(/`\r?\n/g, ' ')
    // The words as the shell hands them on: Cl""aude is Claude.
    const bare = command.replace(INSIDE, '')
    const commit = COMMIT.exec(command)
    const isCommit = commit !== null
    const pr = PR.exec(bare)

    if (!isCommit && pr === null) {
      return next(e)
    }

    // The checks below read the first commit's repo and settings, so a second commit (another -C, cd or identity) would pass unread.
    // Counted with quoted text emptied, so a message that names `git commit` is not a second one.
    if ((emptied(command).match(new RegExp(COMMIT.source, 'gi')) ?? []).length > 1) {
      return { deny: `${$.plugin.name}: run one git commit per command, so each one's repo and identity are checked.` }
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
    const ghRepo = new RegExp(`(?:\\s(?:-R|--repo)[ =]?|GH_REPO=)["']?(?:\\S*github\\.com[:/])?(${any})/`, 'i')

    // -C counts only among git's global options: after `commit` it names a commit to reuse.
    // Git applies each -C on top of the last, so the cd and every -C go to it in order.
    const dirs = [
      CD.exec(command)?.[1],
      ...[...(commit?.[1] ?? '').matchAll(GIT_DIR)].map(([, a, b, c]) => a ?? b ?? c),
    ].flatMap(dir => (dir === undefined ? [] : ['-C', dir.replace(/^\/([a-zA-Z])\//, '$1:/')]))
    const git = async (...args: string[]) =>
      (await $.process.run(['git', ...dirs, ...args])).stdout.trim()

    const owner = ghRepo.exec(command)?.[1] ?? origin.exec(await git('remote', 'get-url', 'origin'))?.[1]

    if (owner === undefined) {
      return next(e)
    }

    // A message file is read where git and gh look for it: the cd and each -C in turn, an absolute one resetting the path.
    const base = dirs.filter((_, i) => i % 2 === 1).reduce((path, dir) => (ABSOLUTE.test(dir) || path === '' ? dir : `${path}/${dir}`), '')
    const files = [...command.matchAll(MESSAGE_FILE)]
      .map(([, a, b, c]) => (a ?? b ?? c ?? '').replace(/^\/([a-zA-Z])\//, '$1:/'))
      .filter(file => file !== '' && file !== '-')
      .map(file => (ABSOLUTE.test(file) || base === '' ? file : `${base}/${file}`))
    // An unreadable file passes: git or gh will fail on it themselves.
    const messages = await Promise.all(files.map(file => $.fs.read(file).then(String, () => '')))

    if (TRAILER.test(bare) || messages.some(message => TRAILER.test(message))) {
      return { deny: `${$.plugin.name}: no Claude trailers in ${owner} repos. Remove the Co-Authored-By / Generated with Claude Code line and retry.` }
    }

    const mergeAs = pr?.[1]?.toLowerCase() === 'merge' ? MERGE_AS.exec(bare.slice(pr.index))?.[1] : undefined

    if (mergeAs !== undefined && !NOREPLY.test(mergeAs)) {
      return { deny: `${$.plugin.name}: this merge would carry the address "${mergeAs}" as author. ${owner} repos take the GitHub noreply address only.` }
    }

    if (isCommit) {
      // Settings count up to `commit` only: after it comes the message, which sets nothing.
      const before = command.slice(0, commit?.index ?? 0)
      const after = command.slice((commit?.index ?? 0) + (commit?.[0].length ?? 0))
      const settings = `${before}${commit?.[0] ?? ''}`.replace(INSIDE, '')

      if (UNREAD.test(settings)) {
        return { deny: `${$.plugin.name}: this command points git at config the guard cannot read (GIT_CONFIG_*, HOME, EMAIL, --config-env, include.path), so the commit's identity is unknown. Set it with -c user.email=<noreply address> instead.` }
      }

      const inline = [
        ...(after.match(WORD) ?? []).flatMap((word, i, words) => {
          const author = AUTHOR.exec(word)
          const value = author?.[1] ?? words[i + 1] ?? ''

          return author === null ? [] : [IDENT_EMAIL.exec(value)?.[1] ?? value.replace(INSIDE, '')]
        }),
        ...[...settings.matchAll(SET_EMAIL)].map(([, email = '']) => email),
      ]
      // Git config still supplies an identity unless both are overridden: by `-c user.email=x` among git's own options, or by both variables set on git's own command.
      // Read by word and with quoted text emptied: a user.name that reads `-c user.email=x`, or X="GIT_AUTHOR_EMAIL=x ...", overrides nothing,
      // nor do variables another command was given (echo GIT_AUTHOR_EMAIL=x ...; git commit).
      const isOverridden =
        (commit?.[1]?.match(WORD) ?? []).some((word, i, words) => words[i - 1] === '-c' && /^user\.email=./i.test(word.replace(INSIDE, ''))) ||
        ['AUTHOR', 'COMMITTER'].every(who => new RegExp(r`(?<!\w)GIT_${who}_EMAIL=\S[^;&|\n(){}\`]*$`).test(emptied(before)))
      // git var resolves what the commit would carry from config and the session: author.email and committer.email as well as user.email.
      const resolved = isOverridden
        ? []
        : await Promise.all(['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].map(async ident => IDENT_EMAIL.exec(await git('var', ident))?.[1]))
      // An amend keeps the old author unless told otherwise, and the old message too unless a new one is given.
      // -C <commit> (--reuse-message) takes another commit's author and message the same way, with no editor.
      const reused = REUSE.exec(after)
      // A -C names the source even on an amend (--amend -C HEAD~1).
      const ref = reused?.[1] ?? reused?.[2] ?? reused?.[3] ?? (/\s--am\w*/.test(after) ? 'HEAD' : undefined)
      const amended = ref === undefined ? undefined : (await git('log', '-1', '--format=%ae%n%B', ref)).split('\n')
      // A ref git cannot read gives no author: git will fail on it itself.
      const keptAuthor = amended?.[0] && !/\s--(reset-author|author)\b/.test(after) ? [amended[0]] : []
      const keepsMessage = /\s--no-e\w*/.test(after) || reused !== null || !/\s(-[a-zA-Z]*[mF](?![a-zA-Z])|--(m|fil)\w*)/.test(after)

      if (amended !== undefined && keepsMessage && TRAILER.test(amended.slice(1).join('\n'))) {
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
