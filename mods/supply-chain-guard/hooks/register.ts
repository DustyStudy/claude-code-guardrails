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

// Stands where the shell puts words the guard cannot see: a $( ), a backtick, a PowerShell ( ), a brace list, what xargs appends.
// One character, so a reading that puts it in never grows past the parser's limit.
const MARK = '\uE000'
// A word the shell fills in can be any words: a verb, a tool's name, or both with a package after.
const isFilled = (word: string) => word.includes(MARK) || /^\$[\w{]/.test(word)

/** Thrown where the verb or the tool is the shell's to fill in: read as an install. */
class Filled extends Error {}

// Each way to read the verb, with the arguments after it. An unlisted option before a word may take that word as its value
// (npm --foo bar install x), so the word after it is read as the verb too, for as many such options as there are.
const readings = (args: Args, valued: RegExp): [string, string[]][] => {
  const { words, at } = parse(args, valued)
  const found: [string, string[]][] = []

  for (const [n, word] of words.entries()) {
    const here = at[n] ?? 0

    // A substitution before the verb can hold the verb itself (--prefix $(echo x install evil)); a variable is read only as the verb.
    if (isFilled(word) || args.slice(0, here).some(arg => arg.includes(MARK))) {
      throw new Filled()
    }

    // bash drops a backslash in a word, cmd a caret: inst\all is install.
    found.push([word.replace(/[\\^]/g, ''), args.slice(here + 1)])

    if (!/^-[^=]*$/.test(args[here - 1] ?? '')) {
      break
    }
  }

  return found
}

// An exact version of a registry name: pkg@1.2.3, @scope/pkg@1.2.3 or pkg[extra]==1.2.3, not a range, a tag, a wildcard or a URL.
const PINNED = /^(@[\w.-]+\/)?[\w.-]+(\[[\w,.-]*\])?(@\d+\.\d+\.\d|==\d)[\w.+-]*$/
// A path on this machine, never a URL or a package name: ., ./x, ..\x, .[dev], ~/x, /x, C:\x.
const LOCAL = /^(\.{1,2}|~)([\\/]|\[|$)|^[\\/](?![\\/])|^[a-z]:[\\/]/i
const NEVER = /$^/

// npx, bunx, uvx and the like fetch the package they run. Their own options end at the first word; --no-install runs only what is there.
// The program they run is read as its own command: npx --no-install npm install x.
const runsUnpinned = (args: Args, valued: RegExp, from: RegExp, also = NEVER) => {
  const { words, at, flags, values } = parse(args, valued, true)
  const named = values.filter(([option]) => from.test(option) || also.test(option)).map(([, value]) => value)
  // With --package or --from the word is a command inside that package, not a package.
  const targets = values.some(([option]) => from.test(option)) ? named : [...named, ...words]

  return (
    (!flags.some(flag => /^--no(-install)?$/.test(flag)) && targets.some(target => !PINNED.test(target))) ||
    handsTo((words[0] ?? '').split('@')[0] ?? '', args.slice((at[0] ?? args.length) + 1), 0)
  )
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
    // Hashes in a requirements file fetched from elsewhere pin nothing: -r https://..., --req=https://..., -rhttps://...
    const isRemote = [
      ...values.filter(([option]) => /^(-r|--requirement)$/.test(option)).map(([, file]) => file),
      ...flags.filter(flag => /^(-r|--r[\w-]*=)/.test(flag)),
      ...(verb === 'sync' ? words : []),
    ].some(file => file.includes('://'))

    // uv pip sync installs what its requirements files name.
    if (verb === 'sync') {
      return !isHashed || isRemote
    }

    if (verb !== 'install') {
      return false
    }

    // pip refuses a package named on the command line under --require-hashes, so with one the flag is not trusted; --help only prints.
    if (words.length === 0 && !isRemote && (isHashed || hasFlag(rest, /^(-h|--help)$/))) {
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

// --package-lock=false, =0 and =null all turn it off: anything but =true counts.
const NO_LOCK = /^--no-(package-lock|lockfile)$|^--(package-lock|lockfile)=(?!true$)/
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

      if (runs.test(verb)) {
        return run(rest)
      }

      // pnpm exec pip install x, yarn run pip install x, and pnpm's own fallback, pnpm pip install x: the program is read as its own command.
      return /^(exec|run|run-script)$/.test(verb)
        ? handsTo(words[0] ?? '', rest.slice((at[0] ?? rest.length) + 1), 0)
        : (installs.test(verb) && (words.length > 0 || isLockless)) || handsTo(verb, rest, 0)
    })
  }

  return { check: (args: Args) => check(args), run }
}

// npm takes any start of a verb that no other verb shares: upd, creat, exe. `least` is the shortest start read as the verb.
const short = (verb: string, least: number) => verb.slice(0, least) + [...verb.slice(least)].reduceRight((rest, char) => `(${char}${rest})?`, '')
const npm = js(
  '--loglevel|-w|--workspace|--registry|--prefix|--cache|--userconfig|--omit|--include|--tag',
  // npm takes any of these spellings for install, and update, link and init fetch a named package too.
  options(
    `i|it|add|ln|${short('install-test', 2)}|${short('isntall', 2)}|${short('update', 2)}|${short('upgrade', 3)}|${short('udpate', 2)}|${short('link', 3)}|${short('init', 3)}|${short('innit', 3)}|${short('create', 2)}`,
  ),
  options(`x|${short('exec', 3)}`),
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
const GO = options('-o|-C|-ldflags|-gcflags|-asmflags|-tags|-mod|-modfile|-p|-pkgdir|-buildmode|-compiler|-overlay|-toolexec|-exec')
const GO_PINNED = /^[^@\s]+@v\d+\.\d+\.\d[\w.+-]*$/
const goInstall = named(GO, /^install$/, ({ words }) => words.some(word => !LOCAL.test(word) && !GO_PINNED.test(word)))
// go run takes one package, then that program's arguments. Without a version it is built from go.mod and go.sum.
const goRun = named(GO, /^run$/, ({ words: [target = ''] }) => target.includes('@') && !GO_PINNED.test(target))
// An exact version: evil/x:* and evil/x:^1.0 take whatever is newest.
const composer = named(
  options('-d|--working-dir'),
  /^req(u|ui|uir|uire)?$/,
  ({ words }) => words.some(word => !/^[^:=\s]+[:=]v?\d+\.\d+\.\d[\w.+-]*$/.test(word)),
)

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
  ['go', args => goInstall(args) || goRun(args)],
  ['composer', args => composer(args.filter(arg => arg !== 'global'))],
]
const bin = (name: string) => new RegExp(String.raw`^(.*[\\/])?(${name})(\.exe|\.cmd|\.bat|\.ps1)?$`, 'i')
const BINARIES = [
  ...TOOLS.map(([label, check, name = label]) => [label, check, bin(name)] as const),
  // $(which pip) install x: a program the shell names can be any of the tools.
  // shortcut: not the runners (npx, uvx), which would deny every such program ($EDITOR notes.txt); $(echo npx) pkg passes.
  [
    'a program the shell names',
    (args: Args) => TOOLS.some(([label, check]) => !/^(npx|pnpx|bunx|uvx)$/.test(label) && check(args)),
    bin(MARK),
  ] as const,
]
const ANY = new RegExp(BINARIES.map(([, , binary]) => binary.source).join('|'), 'i')

// A tool that runs another (uv run, python -m, corepack, npx). A chain too long to follow is not read, so it does not run.
function handsTo(name: string, args: Args, depth: number): boolean {
  if (isFilled(name)) {
    throw new Filled()
  }

  const check = BINARIES.find(([, , binary]) => binary.test(name))?.[1]

  return check !== undefined && (depth > 3 || check(args, depth + 1))
}

// A second reading that puts a word where the shell would put arguments the guard cannot see: a brace list, xargs' {} and the
// arguments xargs or parallel append. One character for a brace, so a line of JSON grows by nothing and stays within the parser's limit.
const marked = (command: string) => command.replace(/(?<!\$)\{(?=\S)/g, MARK).replace(/\b(xargs|parallel)\b[^;|&\n]*/g, `$& ${MARK}`)

// A third reading that leaves the mark where each $( ), ( ) and backtick stood, and where a variable is the program: the parser says
// that a call has a substitution, not where, and the place decides whether it can be the verb or the tool.
// shortcut: nine levels of ( ), one more than the parser reads of $( ); a deeper one is left to the first reading.
const placed = (command: string) => {
  let text = command.replace(/(^|[;&|\n(]\s*)\$\{?\w+\}?(?=[ \t]+[^\s=])/g, `$1${MARK}`)

  for (let depth = 0; depth < 9; depth++) {
    text = text.replace(/\$?\([^()]*\)|`[^`\n]*`/g, MARK)
  }

  return text
}

const denies = (check: Check, args: Args) => {
  try {
    return check(args)
  } catch (error) {
    if (error instanceof Filled) {
      return true
    }

    throw error
  }
}

/** Why the command does not run, if it does not. */
const refusal = (command: string): string | undefined => {
  // Too long, too deep or too costly for the parser: not read, so not run. Asked of the command as written; if only the second
  // reading cannot be read, invocations throws and the .catch below denies.
  const unread = unreadable(command)

  if (unread !== undefined) {
    return `${unread}, so it does not run. Split it up, or give the user the exact command to run themselves with the \`!\` prefix.`
  }

  for (const source of new Set([command, marked(command), placed(command)])) {
    // One pass finds whether any tool is called at all: most commands call none.
    for (const [label, check, binary] of invocations(source, ANY).length > 0 ? BINARIES : []) {
      // Where the shell fills arguments in ($( ), a backtick, PowerShell ( )), any word can stand there: read as a package named.
      if (invocations(source, binary).some(args => denies(check, args.map(arg => (arg === DYNAMIC ? MARK : arg))))) {
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
