import type { Register } from 'claude-code'

import { DYNAMIC, invocations, unreadable } from './shell'

type Args = readonly string[]
// Whether a tool's argument list installs or runs a package nothing pins. `depth` counts tools handing on to each other (uv run python -m pip).
type Check = (args: Args, depth?: number) => boolean

const options = (names: string) => new RegExp(`^(${names})$`)

// An argument list as its words, its flags, and the values of the options that take one (--opt value, --opt=value).
// An option the table does not list leaves its value as a word, so the install reads as naming a package: a gap in a table denies.
const parse = (args: Args, valued: RegExp, isFirstWordLast = false) => {
  const words: string[] = []
  const at: number[] = []
  const flags: string[] = []
  const values: [string, string][] = []
  let hasEnded = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    const [, option, attached] = /^(--[\w-]+)=([\s\S]*)$/.exec(arg) ?? []

    if (hasEnded || !arg.startsWith('-')) {
      words.push(arg)
      at.push(i)

      if (isFirstWordLast) {
        break
      }
    } else if (arg === '--') {
      hasEnded = true
    } else if (option !== undefined && valued.test(option)) {
      values.push([option, attached ?? ''])
    } else if (valued.test(arg)) {
      values.push([arg, args[++i] ?? ''])
    } else {
      flags.push(arg)
    }
  }

  return { words, at, flags, values }
}

// Each way to read the verb, with the arguments after it. An unlisted option before the first word may take that word as its
// value (npm --foo bar install x), so the second word is read as the verb too.
const readings = (args: Args, valued: RegExp): [string, string[]][] => {
  const { words, at } = parse(args, valued)
  const first = at[0] ?? 0
  const picks = first > 0 && /^-[^=]*$/.test(args[first - 1] ?? '') ? [0, 1] : [0]

  return picks.flatMap(n => {
    const word = words[n]

    // bash drops a backslash in a word, cmd a caret: inst\all is install.
    return word === undefined ? [] : [[word.replace(/[\\^]/g, ''), args.slice((at[n] ?? 0) + 1)] as [string, string[]]]
  })
}

// An exact version: pkg@1.2.3 or pkg==1.2.3, not a range, a tag or a wildcard.
const PINNED = /^@?[^@=\s]+(@\d+\.\d+\.\d|==\d)[\w.+-]*$/
// A path on this machine, never a URL or a package name: ., ./x, ..\x, .[dev], ~/x, /x, C:\x.
const LOCAL = /^(\.{1,2}|~)([\\/]|\[|$)|^[\\/](?![\\/])|^[a-z]:[\\/]/i
const NEVER = /$^/

// npx, bunx, uvx and the like fetch the package they run. Their own options end at the first word; --no-install runs only what is there.
const runsUnpinned = (args: Args, valued: RegExp, from: RegExp, also = NEVER) => {
  const { words, flags, values } = parse(args, valued, true)
  const named = values.filter(([option]) => from.test(option) || also.test(option)).map(([, value]) => value)
  // With --package or --from the word is a command inside that package, not a package.
  const targets = values.some(([option]) => from.test(option)) ? named : [...named, ...words]

  return !flags.some(flag => /^--no(-install)?$/.test(flag)) && targets.some(target => !PINNED.test(target))
}

const PIP = options(
  '-r|--requirement|-c|--constraint|-e|--editable|-t|--target|-i|--index-url|--extra-index-url|-f|--find-links|--retries|--timeout|--proxy|--cache-dir|--trusted-host|--log|--python|--platform|--python-version|--implementation|--abi|--root|--prefix|--src|--upgrade-strategy|-C|--config-settings|--no-binary|--only-binary|--progress-bar|--root-user-action|--report|--use-feature|--use-deprecated|--exists-action|--cert|--client-cert|--keyring-provider|--global-option|--index|--default-index',
)
// pip options known to take no value: only after one of these (or a value) is the next option read as an option.
const PIP_FLAG =
  /^(-q|-v|-U|-I|-h|--help|--require-hashes|--quiet|--verbose|--upgrade|--user|--pre|--no-deps|--no-cache-dir|--no-input|--no-index|--force-reinstall|--ignore-installed|--disable-pip-version-check|--dry-run|--prefer-binary|--no-build-isolation|--no-compile|--break-system-packages|--isolated|--no-color|--system|--strict)$/
// pip takes the word after an option that wants a value as that value, and accepts shortened option names: in
// `--log --require-hashes` and `--lo --require-hashes` no hash is required. A flag counts only where nothing before it can take it.
const hasFlag = (rest: Args, flag: RegExp) =>
  rest.some((arg, i) => {
    const before = rest[i - 1] ?? ''

    return flag.test(arg) && (!/^-[^=]*$/.test(before) || PIP_FLAG.test(before))
  })

const pip: Check = args =>
  readings(args, PIP).some(([verb, rest]) => {
    const { words, flags, values } = parse(rest, PIP)
    const isHashed = hasFlag(rest, /^--require-hashes$/)

    // uv pip sync installs what its requirements files name.
    if (verb === 'sync') {
      return !isHashed
    }

    if (verb !== 'install') {
      return false
    }

    // pip refuses a package named on the command line under --require-hashes, so with one the flag is not trusted; --help only prints.
    if (words.length === 0 && (isHashed || hasFlag(rest, /^(-h|--help)$/))) {
      return false
    }

    const editable = values.filter(([option]) => /^(-e|--editable)$/.test(option))

    // -e exempts a path on this machine and nothing beside it: not a git+ URL, a package name, or a requirements file.
    return !(
      editable.length > 0 &&
      words.length === 0 &&
      editable.every(([, path]) => LOCAL.test(path)) &&
      !values.some(([option]) => /^(-r|--requirement)$/.test(option)) &&
      flags.every(flag => PIP_FLAG.test(flag))
    )
  })

const NO_LOCK = /^--no-(package-lock|lockfile)$|^--package-lock=false$/
const PACKAGE = /^(-p|--package)$/

// A package named on the command line comes from the registry as it is today, not from a lockfile.
const js = (valuedNames: string, installs: RegExp, runs: RegExp) => {
  const valued = options(valuedNames)
  const runValued = options(`${valuedNames}|-p|--package|-c|--call`)
  const run: Check = args => runsUnpinned(args, runValued, PACKAGE)
  const check = (args: Args, nested = 0): boolean => {
    const isLockless = args.some(arg => NO_LOCK.test(arg))

    // yarn --no-lockfile: no verb is an install.
    if (isLockless && parse(args, valued).words.length === 0) {
      return true
    }

    return readings(args, valued).some(([verb, rest]) => {
      const { words, at } = parse(rest, valued)

      // yarn global add, yarn workspace web add, yarn workspaces foreach add: the verb comes after.
      if (nested < 2 && /^(global|workspaces?)$/.test(verb)) {
        return check(verb === 'global' ? rest : rest.slice((at[0] ?? rest.length) + 1), nested + 1)
      }

      return runs.test(verb) ? run(rest) : installs.test(verb) && (words.length > 0 || isLockless)
    })
  }

  return { check: (args: Args) => check(args), run }
}

const npm = js(
  '--loglevel|-w|--workspace|--registry|--prefix|--cache|--userconfig|--omit|--include|--tag',
  // npm takes any of these spellings for install, and update, link and init fetch a named package too.
  /^(i|in|ins|inst|insta|instal|install|isnt|isnta|isntal|isntall|add|it|install-test|up|update|upgrade|udpate|link|ln|init|innit|create)$/,
  /^(exec|x)$/,
)
const pnpm = js('--filter|-F|-C|--dir|--registry|--loglevel|--store-dir|--reporter', /^(i|install|add|up|update|upgrade|create)$/, /^dlx$/)
const yarn = js('--cwd|--network-timeout|--registry|--modules-folder|--cache-folder|--mutex', /^(install|add|up|upgrade|create)$/, /^dlx$/)
const bun = js('--cwd|--registry', /^(i|install|a|add|update|create)$/, /^x$/)

const UV = options(
  '--directory|--project|--python|-p|--index-url|-i|--extra-index-url|--index|--default-index|--cache-dir|--config-file|--color|--with|-w|--with-requirements|--with-editable|--from|--group|--extra|--package',
)
const WITH = /^(-w|--with(-requirements|-editable)?)$/
const uvx: Check = args => runsUnpinned(args, UV, /^--from$/, WITH)
// uv sync and uv run install from uv.lock. uv lock --upgrade rewrites the lockfile and installs nothing: it runs.
const uv: Check = (args, depth = 0) =>
  readings(args, UV).some(([verb, rest]) => {
    const { words, at, values } = parse(rest, UV, true)
    const after = rest.slice((at[0] ?? rest.length) + 1)

    switch (verb) {
      case 'pip':
        return pip(rest)
      case 'add':
        return words.length > 0
      case 'tool':
        return words[0] === 'run' ? uvx(after) : /^(install|upgrade)$/.test(words[0] ?? '')
      case 'run':
        // uv run pip install x: the command it runs is read as its own.
        return values.some(([option]) => WITH.test(option)) || handsTo(words[0] ?? '', after, depth)
      default:
        return false
    }
  })

// python -m pip, -mpip, -um pip: the module's arguments follow it.
const python: Check = (args, depth = 0) =>
  args.some((arg, i) => {
    const [isModule, attached] = /^-[a-ln-zA-Z]*m(.*)$/.exec(arg) ?? []

    return isModule !== undefined && handsTo(attached || (args[i + 1] ?? ''), args.slice(attached ? i + 1 : i + 2), depth)
  })

// corepack npm install x, corepack pnpm@9 add x.
const corepack: Check = (args, depth = 0) => handsTo((args[0] ?? '').split('@')[0] ?? '', args.slice(1), depth)

const PIPX = options('--spec|--python|--pip-args|--index-url|-i|--suffix|--preinstall')
const pipx: Check = args =>
  readings(args, PIPX).some(([verb, rest]) =>
    verb === 'run' ? runsUnpinned(rest, PIPX, /^--spec$/) : /^(install|inject|upgrade)$/.test(verb),
  )

// A tool with one install verb: denied when what it names is not pinned.
const named =
  (valued: RegExp, verbs: RegExp, isUnpinned: (parsed: ReturnType<typeof parse>) => boolean): Check =>
  args =>
    readings(args, valued).some(([verb, rest]) => verbs.test(verb) && isUnpinned(parse(rest, valued)))

// --git is not listed, so its URL is a word: a crate from anywhere but --path needs --locked.
const cargo = named(
  options('--path|--root|--target-dir|-j|--jobs|--profile|--features|-F|--version|--vers|--bin|--example|--target|--registry|--index|--config|-Z'),
  /^install$/,
  ({ words, flags }) => words.length > 0 && !flags.includes('--locked'),
)
const gem = named(
  options('-v|--version|-i|--install-dir|-n|--bindir|-s|--source|-P|--trust-policy|--platform'),
  /^i(n|ns|nst|nsta|nstal|nstall)?$/,
  ({ words, values }) => words.length > 0 && !values.some(([option]) => /^(-v|--version)$/.test(option)),
)
const go = named(
  options('-o|-C|-ldflags|-gcflags|-asmflags|-tags|-mod|-modfile|-p|-pkgdir|-buildmode|-compiler|-overlay|-toolexec'),
  /^install$/,
  ({ words }) => words.some(word => !LOCAL.test(word) && !/^[^@\s]+@v\d+\.\d+\.\d[\w.+-]*$/.test(word)),
)
const composer = named(options('-d|--working-dir'), /^req(u|ui|uir|uire)?$/, ({ words }) => words.some(word => !/^[^:=\s]+[:=]./.test(word)))

// shortcut: the install and run verbs of these tools; poetry and conda pass, and a script that installs is not read. Upgrade if those come into use.
const TOOLS: readonly (readonly [string, Check, string?])[] = [
  ['pip', pip, String.raw`pip(-?\d[\d.]*)?`],
  ['python', python, String.raw`(python|pypy)w?[\d.]*|py`],
  ['uv', uv],
  ['uvx', uvx],
  ['pipx', pipx],
  ['npm', npm.check],
  ['pnpm', pnpm.check],
  ['yarn', yarn.check],
  ['bun', bun.check],
  ['npx', npm.run],
  ['pnpx', pnpm.run],
  ['bunx', bun.run],
  ['corepack', corepack],
  // cargo +nightly install, composer global require: neither word is the verb or a package.
  ['cargo', args => cargo(args.filter(arg => !arg.startsWith('+')))],
  ['gem', gem],
  ['go', go],
  ['composer', args => composer(args.filter(arg => arg !== 'global'))],
]
const bin = (name: string) => new RegExp(String.raw`^(.*[\\/])?(${name})(\.exe|\.cmd|\.bat|\.ps1)?$`, 'i')
const BINARIES = TOOLS.map(([label, check, name = label]) => [label, check, bin(name)] as const)
const ANY = bin(TOOLS.map(([label, , name = label]) => name).join('|'))

// A tool that runs another (uv run, python -m, corepack). A chain too long to follow is not read, so it does not run.
function handsTo(name: string, args: Args, depth: number): boolean {
  const check = BINARIES.find(([, , binary]) => binary.test(name))?.[1]

  return check !== undefined && (depth > 3 || check(args, depth + 1))
}

const MARK = 'unresolved-argument'

// A second reading that puts a word where the shell would put arguments the guard cannot see: a brace list, xargs' {} and the
// arguments xargs or parallel append. One character for a brace, so a line of JSON grows by nothing and stays within the parser's limit.
const marked = (command: string) => command.replace(/(?<!\$)\{(?=\S)/g, 'X').replace(/\b(xargs|parallel)\b[^;|&\n]*/g, '$& X')

/** Why the command does not run, if it does not. */
const refusal = (command: string): string | undefined => {
  // Too long, too deep or too costly for the parser: not read, so not run. Asked of the command as written; if only the second
  // reading cannot be read, invocations throws and the .catch below denies.
  const unread = unreadable(command)

  if (unread !== undefined) {
    return `${unread}, so it does not run. Split it up, or give the user the exact command to run themselves with the \`!\` prefix.`
  }

  for (const source of new Set([command, marked(command)])) {
    // One pass finds whether any tool is called at all: most commands call none.
    for (const [label, check, binary] of invocations(source, ANY).length > 0 ? BINARIES : []) {
      // Where the shell fills arguments in ($( ), a backtick, PowerShell ( )), any word can stand there: read as a package named.
      if (invocations(source, binary).some(args => check(args.map(arg => (arg === DYNAMIC ? MARK : arg))))) {
        return `\`${label}\` would install or run a package no lockfile or hash pins. Install from the lockfile (npm ci, pip install --require-hashes -r), run a tool that is already installed (npx --no-install) or one exact version (npx pkg@1.2.3), or give the user the exact command to run themselves with the \`!\` prefix.`
      }
    }
  }

  return undefined
}

// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: SHELL_TOOLS }, ($, e, next) => {
    // A Monitor that opens a WebSocket has no command.
    const reason = refusal(String((e as { command?: unknown }).command ?? ''))

    return reason === undefined ? next(e) : { deny: `${$.plugin.name}: ${reason}` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
