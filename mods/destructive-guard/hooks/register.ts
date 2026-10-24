import type { Register } from 'claude-code'

import { invocations } from './shell'

const bin = (names: string) => new RegExp(String.raw`^(.*[\\/])?(${names})(\.exe|\.cmd|\.ps1)?$`, 'i')

// The bare words of a call: its subcommands and targets, without options or the values of the options listed.
const words = (args: readonly string[], valued = /(?!)/) =>
  args.filter((word, i) => !word.startsWith('-') && !valued.test(args[i - 1] ?? ''))

// Where the session's paths sit, as the deny rules compare them.
type Places = { home: string; project: string | undefined; temps: readonly string[]; bases: readonly string[] }

// One spelling per path: forward slashes, lower case, Git Bash's /c/ as c:/, . and .. resolved.
const norm = (path: string) => {
  const parts: string[] = []

  for (const part of path.replace(/\\/g, '/').replace(/^\/([a-z])(\/|$)/i, '$1:/').toLowerCase().split('/')) {
    if (part === '..') {
      if (parts.length > 1) {
        parts.pop()
      }
    } else if (part !== '.' && (part !== '' || parts.length === 0)) {
      parts.push(part)
    }
  }

  return parts.join('/') || '/'
}

const isAbsolute = (path: string) => /^([\\/]|[a-z]:([\\/]|$))/i.test(path)
const isUnder = (path: string, root: string) => path.startsWith(`${root.replace(/\/$/, '')}/`)

// A folder whose loss is the user's whole tree: a drive or file system root, or home.
const isTop = (path: string, home: string) => /^([a-z]:)?\/?$/.test(path) || path === home

const HOME_VAR = /^(~|\$HOME|\$\{HOME\}|\$env:(USERPROFILE|HOME)|%USERPROFILE%)(?=[\\/]|$)/i
// The base of a cd whose folder a variable names: relative targets below it are unknown.
const UNKNOWN = '\0'

// Every place a recursive delete's target can land; undefined when a variable leaves it unknown.
const landings = (target: string, places: Places): string[] | undefined => {
  const path = target.replace(HOME_VAR, places.home)

  // A drive-relative path (C:..\x) follows that drive's own folder, which the guard does not know.
  if (/[$%]/.test(path) || /^[a-z]:[^\\/]/i.test(path)) {
    return undefined
  }

  // A trailing glob empties the folder above it: rm -rf * and rm -rf */ clear the whole project.
  const folder = path.replace(/[\\/]+$/, '').replace(/([\\/]|^)[^\\/]*[*?[][^\\/]*$/, '$1') || '.'

  if (isAbsolute(folder)) {
    return [norm(folder)]
  }

  return places.bases.includes(UNKNOWN) ? undefined : places.bases.map(base => norm(`${base}/${folder}`))
}

// A recursive delete is safe below the project or a temp folder, never at their top.
const isSafe = (target: string, places: Places) => {
  const spots = landings(target, places)

  return (
    spots !== undefined &&
    spots.every(spot => [places.project, ...places.temps].some(root => root !== undefined && isUnder(spot, root)))
  )
}

const RM = bin('rm|Remove-Item|ri|del|erase|rd|rmdir')
// rm's -r/-R in a group of its short options (-rf, -Rf), --recursive, PowerShell's -Recurse and its prefixes, cmd's /s.
const RECURSIVE = /^(-[fvdiI]*[rR][rRfvdiI]*|--recursive|-r(e(c(u(r(se?)?)?)?)?)?|\/s)$/i
// PowerShell options whose value is not a target.
const PS_VALUE = /^-(Exclude|Include|Filter|ErrorAction|Stream|WarningAction)$/i
const isRecursive = (args: readonly string[]) => args.some(arg => RECURSIVE.test(arg))
const isWhatIf = (args: readonly string[]) => args.some(arg => /^-WhatIf$/i.test(arg))

// PowerShell's attached forms as separate words: -Recurse:$true is -Recurse, -Path:x is -Path x, and a,b is two targets.
const spread = (args: readonly string[]) =>
  args.flatMap(arg => {
    const [, name, value] = /^(-\w+):(.*)$/.exec(arg) ?? []

    if (name === undefined || value === undefined) {
      return arg.startsWith('-') ? [arg] : arg.split(',').filter(Boolean)
    }

    return /^\$false$/i.test(value) ? [] : /^\$true$/i.test(value) ? [name] : [name, ...value.split(',').filter(Boolean)]
  })

const deletes = (raw: readonly string[], places: Places) => {
  const args = spread(raw)

  return isRecursive(args) && !isWhatIf(args) && words(args, PS_VALUE)
    // cmd's /s and /q are options, but only in a cmd-style call: in Git Bash /c is the C: drive.
    .filter(word => !(args.some(arg => /^\/s$/i.test(arg)) && /^\/[a-z]$/i.test(word)))
    .some(target => !isSafe(target, places))
}

const GIT = bin('git')
const GIT_VALUE = /^(-C|-c|--git-dir|--work-tree|--namespace)$/

// What a git call destroys, by name; undefined when nothing.
const gitLoss = (args: readonly string[]): string | undefined => {
  const [sub, ...rest] = words(args, GIT_VALUE)

  const has = (long: string, short: string) => args.some(arg => arg === long || new RegExp(`^-[a-zA-Z]*${short}[a-zA-Z]*$`).test(arg))
  const isDryRun = has('--dry-run', 'n')

  if (sub === 'push' && !isDryRun && (has('--force', 'f') || args.includes('--mirror') || rest.some(word => word.startsWith('+')))) {
    return 'git push --force'
  }

  if (sub === 'reset' && args.includes('--hard')) {
    return 'git reset --hard'
  }

  if (sub === 'clean' && has('--force', 'f') && !isDryRun) {
    return 'git clean -f'
  }

  // A forced branch change drops the uncommitted edits.
  if ((sub === 'checkout' || sub === 'switch') && (has('--force', 'f') || args.includes('--discard-changes'))) {
    return `git ${sub} --force`
  }

  // A restore of the staging area alone keeps the files.
  const isStagedOnly = has('--staged', 'S') && !has('--worktree', 'W')

  if ((sub === 'checkout' || sub === 'restore') && !isStagedOnly && rest.some(word => /^(\.[\\/]?|:\/\*?|\*|:\(top\).*)$/.test(word))) {
    return `git ${sub} .`
  }

  return sub === 'stash' && rest[0] === 'clear' ? 'git stash clear' : undefined
}

const DB = bin('psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|mongo|redis-cli|duckdb|cockroach|Invoke-Sqlcmd')
// Statements that remove data: read from the whole command line, heredoc bodies included.
const SQL_LOSS = /\b(DROP\s+(TABLE|DATABASE|SCHEMA|VIEW|COLUMN|USER|ROLE|COLLECTION)\b|TRUNCATE\b|FLUSHALL\b|FLUSHDB\b)|\.drop(Database)?\(\)/i
// shortcut: a DELETE counts as unbounded when no WHERE follows it before a semicolon, so one in a comment or string still counts; parse the SQL if that bites.
const isUnboundedDelete = (text: string) => [...text.matchAll(/\bDELETE\s+FROM\b[^;]*/gi)].some(([statement]) => !/\bWHERE\b/i.test(statement))

const DISK = bin('mkfs(\\.\\w+)?|diskpart|Format-Volume|Clear-Disk|Remove-Partition|Initialize-Disk')

// The first thing a command line destroys, as the deny names it, with what to do instead.
const loss = (command: string, places: Places): string | undefined => {
  if (invocations(command, RM).some(args => deletes(args, places))) {
    return 'a recursive delete outside the project or a temp folder. Delete inside the project by path, or'
  }

  const git = invocations(command, GIT).map(gitLoss).find(Boolean)

  if (git !== undefined) {
    return `\`${git}\`, which loses work for good. ${git === 'git push --force' ? 'Use `--force-with-lease`, or' : 'Commit or `git stash` first, or'}`
  }

  if (invocations(command, DB).length > 0 && (SQL_LOSS.test(command) || isUnboundedDelete(command))) {
    return 'a statement that drops or empties a table or database. Add a WHERE, or'
  }

  const formats = invocations(command, DISK).some(args => !isWhatIf(spread(args)))
  // /dev/null and /dev/zero take any write.
  const writesDisk = invocations(command, bin('dd')).some(args => args.some(arg => /^of=\/dev\/(?!(null|zero)$)/.test(arg)))

  if (formats || writesDisk) {
    return 'a disk format or raw write. Instead'
  }

  return undefined
}

// The folder the session works in counts as the project only below home: at home or a root it would cover everything.
const placesOf = (cwd: string, home: string, temps: readonly (string | undefined)[], command: string): Places => {
  const root = norm(cwd)
  const homeAt = norm(home)
  // shortcut: a cd in the command moves the base of relative targets to each folder it names, in any order; upgrade if a script cds back and forth.
  const cds = invocations(command, bin('cd|pushd|chdir|Set-Location|sl')).map(args => {
    // A bare cd goes home.
    const dir = words(args)[0] ?? '~'

    if (HOME_VAR.test(dir)) {
      return dir.replace(HOME_VAR, home)
    }

    return /[$%]/.test(dir) ? UNKNOWN : isAbsolute(dir) ? dir : `${cwd}/${dir}`
  })

  return {
    home: homeAt,
    project: isTop(root, homeAt) ? undefined : root,
    temps: ['/tmp', ...temps].filter((one): one is string => one !== undefined && one !== '').map(norm).filter(one => !isTop(one, homeAt)),
    bases: [cwd, ...cds],
  }
}

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'
    const temps = [await $.env.get('TEMP'), await $.env.get('TMP'), await $.env.get('TMPDIR')]
    const cwd = await $.session.cwd()
    const check = (command: string) => loss(command, placesOf(cwd, home, temps, command))
    // Bash expands rm -rf {dist,../x} to both words before rm sees them; the parser would read the braces as a group.
    const expanded = e.command.replace(/(\S*)\{([^{}\s]*,[^{}\s]*)\}(\S*)/g, (_, pre: string, alternatives: string, post: string) =>
      alternatives.split(',').map(one => `${pre}${one}${post}`).join(' '),
    )
    // Bash drops a backslash before a letter (git re\set is git reset), so the line is read with and without them; a C:\ path keeps its own.
    const unescaped = e.command.replace(/\S+/g, word => (/^[a-z]:/i.test(word) ? word : word.replace(/\\(?=[A-Za-z])/g, '')))
    const found = check(e.command) ?? (e.tool === 'Bash' ? (check(expanded) ?? check(unescaped)) : undefined)

    return found === undefined
      ? next(e)
      : { deny: `${$.plugin.name}: this runs ${found} if the user wants it, give them the exact command to run themselves with the \`!\` prefix.` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))
}
