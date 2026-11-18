import type { Register } from 'claude-code'

import { invocations } from './shell'

const bin = (names: string) => new RegExp(String.raw`^(.*[\\/])?(${names})(\.exe|\.cmd|\.ps1)?$`, 'i')

// One spelling per path, as in self-guard: forward slashes, lower case, Git Bash's /c/ as c:/, . and .. resolved, and Windows'
// \\?\ prefix, trailing dots and spaces, and name:stream forms folded into the file they open.
const norm = (path: string) => {
  const parts: string[] = []
  const plain = path.replace(/\\/g, '/').replace(/^\/\/[?.]\//, '').replace(/^\/([a-z])(\/|$)/i, '$1:/').toLowerCase()

  for (const [i, raw] of plain.split('/').entries()) {
    const part = raw === '.' || raw === '..' ? raw : i === 0 ? raw : raw.replace(/:.*$/, '').replace(/[. ]+$/, '')

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
const HOME_VAR = /^(~|\$HOME|\$\{HOME\}|\$env:(USERPROFILE|HOME)|\$\{env:(USERPROFILE|HOME)\}|%USERPROFILE%)(?=[\\/]|$)/i

type World = { cwd: string; home: string; allow: readonly RegExp[] }

const resolve = (path: string, { cwd, home }: World) => {
  const expanded = path.replace(HOME_VAR, home)

  return norm(isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`)
}

// Files whose content is a credential, as normalised paths. Each team keeps its own exceptions in SECRET_READ_ALLOW.
const SECRET_FILE = new RegExp(
  [
    String.raw`(^|/)\.env(\.[^/]*)?$`,
    String.raw`/\.aws/(credentials|(sso|cli)/cache/[^/]+)$`,
    String.raw`(^|/)(\.ssh/id_[^/]*|id_(rsa|dsa|ecdsa|ed25519)[^/]*)$`,
    String.raw`\.(pem|key|p12|pfx|ppk|jks|keystore)$`,
    String.raw`\.tfstate(\.[^/]*backup)?$`,
    String.raw`\.tfvars(\.json)?$`,
    String.raw`(^|/)(\.npmrc|\.netrc|_netrc|\.pypirc|\.pgpass|\.git-credentials)$`,
    String.raw`/\.docker/config\.json$`,
    String.raw`/\.kube/config$`,
    String.raw`/(gh|github cli)/hosts\.yml$`,
    String.raw`/\.azure/(msal_token_cache[^/]*|accesstokens\.json|service_principal_entries[^/]*)$`,
    String.raw`/gcloud/(credentials\.db|access_tokens\.db|application_default_credentials\.json|legacy_credentials/.*)$`,
    String.raw`/\.codex/auth\.json$`,
    String.raw`/\.claude/\.credentials\.json$`,
  ].join('|'),
)
// A public key, and the committed stand-ins that hold names but no values.
const NOT_SECRET = /\.(pub|example|sample|template)$/
// Folders that hold little else: a search or copy of the whole folder reads the credential.
const SECRET_DIR = /\/(\.ssh|\.aws|\.aws\/sso|\.aws\/(sso|cli)\/cache|\.azure|\.kube|\.config\/gcloud|\.config\/gh)$/

// What a wildcard is tried against: the credential files of a home folder, and the ones a project folder usually holds.
const HOME_FILES = [
  '.aws/credentials',
  '.aws/sso/cache/x.json',
  '.ssh/id_rsa',
  '.ssh/id_ed25519',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.git-credentials',
  '.kube/config',
  '.docker/config.json',
  '.config/gh/hosts.yml',
  '.codex/auth.json',
  '.claude/.credentials.json',
]
const PROJECT_FILES = ['.env', '.env.local', '.npmrc', 'terraform.tfstate', 'terraform.tfvars', 'id_rsa']

// shortcut: * and ? only, [a-z] sets are read as text, so `cat .en[v]` slips past; read sets if one is seen in use.
const globSource = (glob: string) =>
  glob
    .replace(/[.+^$()|[\]\\{}]/g, '\\$&')
    .replace(/\*\*+/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '[^/]')

const isSecretFile = (path: string, world: World) =>
  SECRET_FILE.test(path) && !NOT_SECRET.test(path) && !world.allow.some(one => one.test(path))

// Whether a resolved path names a credential file, a folder of them, or a wildcard that takes one in.
const isSecret = (path: string, world: World) => {
  if (isSecretFile(path, world) || SECRET_DIR.test(path)) {
    return true
  }

  if (!/[*?]/.test(path)) {
    return false
  }

  const whole = new RegExp(`^${globSource(path)}$`)
  const at = path.lastIndexOf('/') + 1
  // A bare * in a project folder is how every file is listed or searched; it is not taken as aimed at the .env there.
  const local = /^\*+$/.test(path.slice(at)) ? [] : PROJECT_FILES.map(name => path.slice(0, at) + name)

  return [...HOME_FILES.map(name => `${norm(world.home)}/${name}`), ...local].some(file => whole.test(file) && isSecretFile(file, world))
}

// The paths one word of a command names: -Path:x, --file=x and if=x name x, a,b and {a,b} name two.
const pathsOf = (word: string, world: World) =>
  word
    .replace(/["']/g, '')
    .replace(HOME_VAR, world.home)
    .split(',')
    .map(one => one.replace(/^--?[\w-]+[=:](?![\\/])/, '').replace(/^\w+=/, '').replace(HOME_VAR, world.home).replace(/[{}]/g, ''))
    .filter(Boolean)
    .map(one => resolve(one, world))

const secretIn = (words: readonly string[], world: World) => words.flatMap(word => pathsOf(word, world)).find(path => isSecret(path, world))

// Programs that print what a file holds. Ones that only use a file (terraform -var-file, ssh -i, git, aws) or only look at
// it (ls, stat, Test-Path, wc) are not here.
// shortcut: an interpreter given its own code (python -c, node -e, openssl, tar then cat) is not followed beyond READ_CALL;
// no parser fixes that: for it, keep the files out of the account Claude runs as.
const READER = bin(
  'cat|tac|nl|type|gc|Get-Content|head|tail|less|more|bat|base64|xxd|od|hexdump|strings|Format-Hex|certutil|cut|sort|uniq|diff|dd|Import-Csv',
)
const GREP = bin('grep|egrep|rg')
// Their first plain argument is a pattern or script, not a file: `rg "\.tfvars" docs` searches for the name.
const PATTERN_FIRST = bin('fgrep|ag|findstr|Select-String|sls|sed|awk|gawk|jq|yq')
const operands = (args: readonly string[]) => {
  const flagged = args.findIndex(arg => /^(-e|--regexp|-patt\w*)$/i.test(arg))
  const first = args.findIndex((arg, i) => !arg.startsWith('-') && !/^-(literal)?path$/i.test(args[i - 1] ?? ''))

  return args.filter((_, i) => i !== (flagged >= 0 ? flagged + 1 : first))
}

// The one read of a credential file that runs: its variable names, without the values.
const NAMES_PATTERN = /^\^(\[A-Za-z_\]\[A-Za-z0-9_\]\*|\\w\+)( \*)?=$/
const isNamesOnly = (args: readonly string[]) =>
  args.some(arg => /^-[EPh]*o[EPh]*$/.test(arg)) &&
  args.filter(arg => arg.startsWith('-')).every(arg => /^-[oEPh]+$/.test(arg)) &&
  NAMES_PATTERN.test(args.find(arg => !arg.startsWith('-')) ?? '')

// A copy, move or link out of a credential file leaves the content where a later read finds it.
const COPIER = bin('cp|copy|Copy-Item|cpi|mv|move|Move-Item|mi|ren|Rename-Item|rni|ln')
const copiedOut = (args: readonly string[], world: World) => {
  const flag = args.findIndex(arg => /^(-dest\w*|-t|--target-directory)$/i.test(arg))
  const words = args.filter((arg, i) => !/^-[\w-]+$/.test(arg) && (flag < 0 || i !== flag + 1))
  const to = flag >= 0 ? args[flag + 1] : (words.find(arg => /^-dest\w*:/i.test(arg)) ?? words.at(-1))
  const from = secretIn(words.filter(word => word !== to), world)

  // .env to .env.bak, or state to its backup, stays guarded where it lands.
  return from !== undefined && (to === undefined || secretIn([to], world) === undefined) ? from : undefined
}

// A file read by code handed to an interpreter: [IO.File]::ReadAllText, open(), readFileSync.
const READ_CALL = /ReadAll(Text|Bytes|Lines)|ReadLines|OpenText|ReadToEnd|readFileSync|readFile\b|\bopen\(|read_text|read_bytes|file_get_contents/

const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g
// What can stand before the program: an assignment, a keyword, a plain wrapper or a shell with its -c.
const SKIPPED =
  /^(\w+=.*|!|if|then|else|elif|do|while|until|sudo|doas|command|exec|time|nohup|winpty|cmd|\/[ck]|(ba|z|da|k)?sh|pwsh|powershell|-c|-command|-noprofile)(\.exe)?$/i
/** The command as statements, each a pipeline of stages, each the words of one call. A quoted argument is read as a command too. */
const statementsOf = (command: string, depth = 0): string[][][] => {
  const inner =
    depth < 3
      ? (command.match(QUOTED) ?? [])
          .map(quoted => quoted.slice(1, -1))
          // A substitution inside double quotes still runs.
          .filter(text => /\s|\$\(|`/.test(text))
          .flatMap(text => statementsOf(text, depth + 1))
      : []
  // Operators inside quotes are text; a redirection is no word of the call.
  const text = command.replace(QUOTED, quoted => quoted.replace(/[;|&\n(){}`<>]/g, ' ')).replace(/\d*>&\d|\d*>>?\s*[^\s|;&]+/g, ' ')
  const own = text.split(/\|\||&&|[;&\n(){}`]/).map(statement =>
    statement
      .split('|')
      .map(stage => {
        const words = (stage.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map(word => word.replace(/["']/g, ''))

        return words.slice(words.findIndex(word => !SKIPPED.test(word)))
      })
      .filter(words => words.length > 0),
  )

  return [...own.filter(stages => stages.length > 0), ...inner]
}

const nameOf = (program = '') => program.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()

// Programs that hand file names on to the next one: find -exec, ls | xargs, Get-ChildItem | Get-Content.
const LISTER = /^(find|fd|ls|dir|gci|get-childitem|get-item|gi|resolve-path|echo|printf|write-output)$/
// Every environment variable at once. One by name (printenv PATH, $env:PATH) runs.
const dumpsEnv = ([program, ...args]: readonly string[]) => {
  const name = nameOf(program)

  return (
    (name === 'set' && args.length === 0) ||
    (/^(env|printenv|export|declare|typeset)$/.test(name) && args.every(arg => arg.startsWith('-') || (name === 'env' && /^\w+=/.test(arg)))) ||
    (/^(gci|ls|dir|get-childitem|get-item|gi|get-content|gc|type|cat)$/.test(name) && args.some(arg => /^env:[\\/]?(\S*\*\S*)?$/i.test(arg)))
  )
}
// shortcut: "names only" is read from the next stage's first words (cut -f1, wc, select Name), not proven; a longer pipeline
// that puts values back is not followed.
const NAMES_ONLY = /^(cut .*-f ?1( |$)|wc( |$)|(select|select-object|%|foreach-object) (-\w+ )*(name|key)$|measure)/i

// Calls that print a stored credential.
const says = (args: readonly string[], phrase: RegExp) => phrase.test(` ${args.filter(arg => !arg.startsWith('-')).join(' ')} `)
const PRINTERS: readonly (readonly [RegExp, (args: readonly string[]) => boolean])[] = [
  [bin('aws'), args => says(args, / configure export-credentials /) || (says(args, / configure get /) && args.some(arg => /secret|token/i.test(arg)))],
  [bin('gh'), args => says(args, / auth token /) || (says(args, / auth status /) && args.some(arg => /^(-t|--show-token)$/.test(arg)))],
  [bin('git'), args => says(args, / credential(-[\w-]+)? (fill|get) /)],
  [bin('terraform|tofu|terragrunt'), args => says(args, / state pull /)],
  [bin('gcloud'), args => says(args, / print-(access|identity)-token /)],
  [bin('az'), args => says(args, / account get-access-token /)],
]

const WHERE = 'into the conversation, where it is sent to the API, saved in transcripts and can end up in a commit or a command.'
const INSTEAD = String.raw`Ask the user for the one value you need, or read the variable names only: grep -oE '^\w+ *=' <file>, or the file's .example copy.`
const fileDeny = (file: string, how = 'this would put') => `${how} ${file} ${WHERE} ${INSTEAD}`

// shortcut: a path is found only as written (whole, with ~ or a home variable, or as a wildcard); one built from pieces
// (Join-Path), read through a symlink or an 8.3 short name, or by a script file that opens it, slips past.
/** Why the command would put a secret into the conversation, or undefined. */
const finding = (command: string, world: World): string | undefined => {
  const readers = [
    ...invocations(command, READER),
    ...invocations(command, GREP)
      .filter(args => !isNamesOnly(args))
      .map(operands),
    ...invocations(command, PATTERN_FIRST).map(operands),
  ]
  const statements = statementsOf(command)
  const read =
    readers.map(args => secretIn(args, world)).find(Boolean) ??
    invocations(command, COPIER)
      .map(args => copiedOut(args, world))
      .find(Boolean) ??
    // cat < .env, $(< key.pem): the file reaches the program without being its argument.
    secretIn([...command.replace(QUOTED, quoted => quoted.replace(/</g, ' ')).matchAll(/(?<![<\d])<(?![<(&])\s*([^\s<>|;&()]+)/g)].map(([, file = '']) => file), world) ??
    (READ_CALL.test(command) ? secretIn(command.split(/[\s;|&()<>`,[\]"']+/), world) : undefined)

  if (read !== undefined) {
    return fileDeny(read)
  }

  const fed = statements
    .filter(stages => stages.length > 1 || stages.flat().some(word => /^(-exec\w*|xargs)$/.test(word)))
    .flatMap(stages => stages.filter(([program]) => LISTER.test(nameOf(program))))
    .map(words => secretIn(words.slice(1), world))
    .find(Boolean)
  // f=.env; cat $f and for f in .env*; do cat "$f": the reader is handed the file through a variable.
  const bound = secretIn(
    [...command.matchAll(/(?:^|[\s;({])\$?\w+\s*=\s*([^\s;|&)]+)|\b(?:for|foreach)\s*\(?\s*\$?\w+\s+in\s+([^;)\n]+)/gi)].flatMap(
      ([, value, list]) => (value ?? list ?? '').split(/\s+/),
    ),
    world,
  )
  const handed = (fed !== undefined && readers.length > 0 ? fed : undefined) ?? (readers.some(args => args.some(arg => /\$\{?\w/.test(arg))) ? bound : undefined)

  if (handed !== undefined) {
    return fileDeny(handed, 'this hands a program that prints it')
  }

  if (
    statements.some(stages => stages.some((stage, i) => dumpsEnv(stage) && !NAMES_ONLY.test((stages[i + 1] ?? []).join(' ')))) ||
    /GetEnvironmentVariables/i.test(command)
  ) {
    return `this would put every environment variable, tokens and keys among them, ${WHERE} Read one variable by name (printenv NAME, $env:NAME), or list the names only: env | cut -d= -f1.`
  }

  return PRINTERS.some(([program, prints]) => invocations(command, program).some(prints))
    ? `this would put a stored credential ${WHERE} A program that needs the credential reads it itself; if you need the value, ask the user.`
    : undefined
}

// SECRET_READ_ALLOW: a glob with no folder matches the name anywhere; one with folders matches the end of the path.
const worldOf = (cwd: string, home: string, allowed = ''): World => ({
  cwd,
  home,
  allow: allowed
    .split(',')
    .map(glob => glob.trim())
    .filter(Boolean)
    .map(glob => new RegExp(`(^|/)${globSource(norm(glob.replace(HOME_VAR, home)))}$`)),
})

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: ['Read', 'Grep'] }, async ($, e, next) => {
    const world = worldOf(await $.session.cwd(), (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~', await $.env.get('SECRET_READ_ALLOW'))
    const named = e.tool === 'Read' ? [e.file_path] : [e.path ?? '', ...(e.glob ?? '').split(/\s+/)].filter(Boolean)
    const secret = secretIn(named, world)

    return secret === undefined ? next(e) : { deny: `${$.plugin.name}: ${fileDeny(secret)}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const found = finding(
      e.command,
      worldOf(await $.session.cwd(), (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~', await $.env.get('SECRET_READ_ALLOW')))

    return found === undefined ? next(e) : { deny: `${$.plugin.name}: ${found}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))
}
