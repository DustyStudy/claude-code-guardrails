import type { Register } from 'claude-code'

import { DYNAMIC, invocations, unreadable } from './shell'

const bin = (names: string) => new RegExp(String.raw`^(.*[\\/])?(${names})(\.exe|\.cmd|\.ps1)?$`, 'i')

// One spelling per path: forward slashes, lower case, Git Bash's /c/ as c:/, . and .. resolved, and Windows'
// \\?\ prefix, trailing dots and spaces, and name:stream forms folded into the file they open.
const norm = (path: string) => {
  const parts: string[] = []
  const plain = path.replace(/\\/g, '/').replace(/^\/\/[?.]\//, '').replace(/^\/([a-z])(\/|$)/i, '$1:/').toLowerCase()

  for (const [i, raw] of plain.split('/').entries()) {
    const part = raw === '.' || raw === '..' ? raw : i === 0 ? raw : raw.replace(/:[\s\S]*$/, '').replace(/(?<![. ])[. ]+$/, '')

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
// Either name in either shell: Git Bash on Windows has $USERPROFILE too.
const HOME_VAR =
  /^(~|\$(HOME|USERPROFILE)|\$\{(HOME|USERPROFILE)\}|\$env:(USERPROFILE|HOME)|\$\{env:(USERPROFILE|HOME)\}|%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)(?=[\\/]|$)/i

// moved: the folder a cd in the command leads to. globs: the wildcards already judged in this command.
// asked: the folders a wildcard was tried in. files: their names, once listed. dots: a leading * takes a dot file (PowerShell).
type World = {
  cwd: string
  home: string
  allow: readonly RegExp[]
  moved?: boolean
  globs: Map<string, boolean>
  asked: Set<string>
  files?: ReadonlyMap<string, readonly string[]>
  dots?: boolean
}

const resolve = (path: string, { cwd, home }: World) => {
  // C:.env is .env in drive C's current folder: read as a name in this one.
  const expanded = path.replace(HOME_VAR, home).replace(/^[a-z]:(?=[^\\/])/i, '')

  return norm(isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`)
}

// Files whose content is a credential, as normalised paths. Each team keeps its own exceptions in SECRET_READ_ALLOW.
const SECRET_FILE = new RegExp(
  [
    // .env, .env.local, .env-prod, .envrc and prod.env; not .environment.md. The lookahead keeps it to the file's name, so a
    // long folder name full of ".env" is read once.
    String.raw`(^|/)(?=[^/]*$)[^/]*\.env(rc|[._-][^/]*)?$`,
    // Every variable of a process, as a file.
    String.raw`^/proc/[^/]+/environ$`,
    String.raw`/\.aws/(credentials|(sso|cli|login)/cache/[^/]+)$`,
    // A private key in ~/.ssh can have any name; the files beside it that hold none are known.
    String.raw`(^|/)(\.ssh/(?!(config|known_hosts[^/]*|authorized_keys)$)[^/]+|id_(rsa|dsa|ecdsa|ed25519)[^/]*)$`,
    String.raw`\.(pem|key|p12|pfx|ppk|jks|keystore)$`,
    String.raw`\.tfstate$`,
    String.raw`\.tfvars(\.json)?$`,
    String.raw`(^|/)(\.npmrc|\.netrc|_netrc|\.pypirc|\.pgpass|\.git-credentials|\.terraformrc|terraform\.rc|credentials\.tfrc\.json|\.vault-token)$`,
    String.raw`/\.docker/config\.json$`,
    // kubeconfigs under any name, and the exec plugins' token caches.
    String.raw`/\.kube/.`,
    String.raw`/(gh|github cli)/hosts\.yml$`,
    String.raw`/\.config/git/credentials$`,
    String.raw`/\.azure/(msal_token_cache[^/]*|accesstokens\.json|service_principal_entries[^/]*|azurermcontext\.json|tokencache\.dat)$`,
    String.raw`/\.identityservice/msal\.cache[^/]*$`,
    String.raw`/gcloud/(credentials\.db|access_tokens\.db|application_default_credentials\.json|legacy_credentials/[\s\S]*)$`,
    // A service-account key as the console names it (project-0123456789ab.json).
    String.raw`-[0-9a-f]{12}\.json$`,
    String.raw`/\.codex/auth\.json$`,
    String.raw`/\.claude/\.credentials\.json$`,
    // MCP servers' tokens and the account's own; a project's .mcp.json is left readable, as projects commit it.
    String.raw`(^|/)\.claude\.json(\.backup[^/]*)?$`,
  ].join('|'),
)
// Two more, read from the file's name alone so that a long path is read once: a state backup (x.tfstate.123.backup) and a
// service-account key by name.
const isSecretName = (name: string) =>
  (name.endsWith('backup') && name.includes('.tfstate.')) ||
  (name.endsWith('.json') && /service[-_]?account|(^|[-_.])sa[-_]key/.test(name))
// A public key, and the committed stand-ins that hold names but no values.
const NOT_SECRET = /\.(pub|example|sample|template)$/
// Folders that hold little else: a search or copy of the whole folder reads the credential.
const SECRET_DIR =
  /\/(\.ssh|\.aws|\.aws\/(sso|login)|\.aws\/(sso|cli|login)\/cache|\.azure|\.identityservice|\.kube|\.docker|\.config|\.config\/(gcloud|gh|git)|appdata\/roaming|appdata\/roaming\/(gcloud|github cli))$/
// The same under the home folder only, where a project has a folder of the same name (.claude), and the home folder itself.
const HOME_DIRS = [
  '',
  ...'.ssh .aws .aws/sso .aws/login .aws/sso/cache .aws/cli/cache .aws/login/cache .azure .kube .docker .config .config/gcloud .config/gh .config/git .claude .codex .terraform.d appdata appdata/local appdata/local/.identityservice appdata/roaming appdata/roaming/gcloud appdata/roaming/terraform.d'
    .split(' ')
    .map(dir => `/${dir}`),
  '/appdata/roaming/github cli',
]

// What a wildcard is tried against. Under the home folder:
const HOME_NAMES = ['.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass', '.git-credentials', '.terraformrc', '.vault-token', '.claude.json']
const GCLOUD = ['credentials.db', 'access_tokens.db', 'application_default_credentials.json', 'legacy_credentials/*', 'legacy_credentials/*/**']
const HOME_FILES = [
  '.aws/credentials',
  '.aws/sso/cache/*',
  '.aws/cli/cache/*',
  '.aws/login/cache/*',
  '.ssh/*',
  '.kube/config',
  '.kube/*',
  '.kube/*/**',
  '.docker/config.json',
  '.config/gh/hosts.yml',
  'appdata/roaming/github cli/hosts.yml',
  '.config/git/credentials',
  '.azure/msal_token_cache*',
  '.azure/accesstokens.json',
  '.azure/service_principal_entries*',
  '.azure/azurermcontext.json',
  '.azure/tokencache.dat',
  'appdata/local/.identityservice/msal.cache*',
  ...GCLOUD.flatMap(name => [`.config/gcloud/${name}`, `appdata/roaming/gcloud/${name}`]),
  '.codex/auth.json',
  '.claude/.credentials.json',
  '.terraform.d/credentials.tfrc.json',
  'appdata/roaming/terraform.d/credentials.tfrc.json',
]
// In any folder. Names a common wildcard would take in whole (*.json and terraform.tfvars.json, service-account.json) are
// left out: `cat *.json` is ordinary work.
const ANY_NAMES =
  '.env .envrc .env.local .env.production .env.development .env.staging .env.test .env.prod .env.dev .npmrc .netrc .pgpass .pypirc .git-credentials .vault-token .terraformrc terraform.tfstate terraform.tfvars id_rsa id_dsa id_ecdsa id_ed25519'.split(
    ' ',
  )
// Under any name: tried only against a wildcard that writes a dot (prod.tfvar*, *.p*), so that README* is not read as README.env.
// shortcut: so `cat prod*` in a folder that holds prod.tfvars runs, as `cat *` does; the guard does not read the disk.
const ANY_ENDINGS = '*.env *.tfstate *.tfstate.backup *.tfvars *.pem *.key *.p12 *.pfx *.ppk *.jks *.keystore'.split(' ')

// SECRET_READ_ALLOW's wildcards: * and ? only.
const globSource = (glob: string) =>
  glob
    .replace(/[.+^$()|[\]\\{}]/g, '\\$&')
    .replace(/\*\*+/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '[^/]')

const isSecretFile = (path: string, world: World) =>
  (SECRET_FILE.test(path) || isSecretName(path.slice(path.lastIndexOf('/') + 1))) && !NOT_SECRET.test(path) && !world.allow.some(one => one.test(path))

// A wildcard as tokens: a character, ? (one character of a name; a [set] is read as one), * (any run of them) or ** (any run).
const tokensOf = (glob: string) => (glob.match(/\*\*+|\[[^\]/]*\]|[\s\S]/g) ?? []).map(one => (one.startsWith('**') ? '**' : one.length > 1 ? '?' : one))
// A * in a listed credential name stands for one character or more: `~/.ssh/*` is tried against a key, not the bare folder.
const listedTokens = (glob: string) => tokensOf(glob).flatMap(one => (one === '*' ? ['?', '*'] : [one]))
const takes = (token: string | undefined, char: string) => token === char || token === '**' || ((token === '?' || token === '*') && char !== '/')
/** The shortest path both wildcards match, or undefined: a breadth-first walk over the pairs of positions. */
const witness = (a: readonly string[], b: readonly string[]) => {
  const seen = new Set<number>()
  let layer: [number, number, string][] = [[0, 0, '']]

  while (layer.length > 0) {
    const next: [number, number, string][] = []

    // The layer grows while it is walked: a * that matches nothing adds a pair at the same length.
    for (const [i, j, text] of layer) {
      const [x, y] = [a[i], b[j]]

      if (seen.has(i * (b.length + 1) + j)) {
        continue
      }

      seen.add(i * (b.length + 1) + j)

      if (x === undefined && y === undefined) {
        return text
      }

      if (x === '*' || x === '**') {
        layer.push([i + 1, j, text])
      }

      if (y === '*' || y === '**') {
        layer.push([i, j + 1, text])
      }

      const char = x !== undefined && x.length === 1 && x !== '?' && x !== '*' ? x : y !== undefined && y.length === 1 && y !== '?' && y !== '*' ? y : 'a'

      if (takes(x, char) && takes(y, char)) {
        next.push([x === '*' || x === '**' ? i : i + 1, y === '*' || y === '**' ? j : j + 1, text + char])
      }
    }

    layer = next
  }

  return undefined
}

// A folder that could not be resolved (cd $DIR): any folder.
const NOWHERE = '**'
const isWild = (path: string) => /[*?[]/.test(path)
// The longest wildcard, and the most of them in one command, that are worked out; past that the answer is yes.
const MAX_GLOB = 260
const MAX_GLOBS = 32
// The most folders listed for one command; past that the command is denied.
const MAX_LISTED = 64

const takesSecret = (path: string, world: World) => {
  const home = norm(world.home)
  const isNowhere = path === NOWHERE || path.startsWith(`${NOWHERE}/`)
  // A bare * in a project folder is how every file is listed or searched; it is not taken as aimed at the .env there.
  // shortcut: so `cat *` in a folder that holds a credential runs; the guard does not read the disk to see whether one is there.
  const name = path.slice(path.lastIndexOf('/') + 1)
  const isBare = /^\*+$/.test(name)

  if (isNowhere && isBare) {
    return false
  }

  const mine = tokensOf(path)
  const files = [
    ...HOME_NAMES.map(one => `${home}/${one}`),
    ...(isBare ? [] : [...ANY_NAMES, ...(/[.?[]/.test(name) ? ANY_ENDINGS : [])].map(one => `**/${one}`)),
    // In an unknown folder a name is tried against the named files, not against "anything in ~/.ssh".
    ...HOME_FILES.filter(one => !isNowhere || !one.endsWith('*')).map(one => `${home}/${one}`),
    '/proc/*/environ',
  ]

  return (
    files.some(file => {
      const found = witness(mine, listedTokens(file))

      return found !== undefined && isSecretFile(found, world)
    }) ||
    (!isNowhere && HOME_DIRS.some(dir => witness(mine, [...home + dir]) !== undefined))
  )
}

// cat * and cat prod* write no credential name: they are tried against the files the folder holds, once the guard has listed it.
// shortcut: a wildcard in a folder's name (cat */prod*) is not listed; walk the folders if one is seen in use.
const takesListed = (path: string, world: World) => {
  const at = path.lastIndexOf('/')
  const dir = path.slice(0, at) || '/'

  if (isWild(dir)) {
    return false
  }

  world.asked.add(dir)

  const name = tokensOf(path.slice(at + 1))

  return (world.files?.get(dir) ?? []).some(
    // bash's * leaves a dot file out unless the wildcard writes the dot.
    file => (world.dots || !file.startsWith('.') || name[0] === '.') && witness(name, [...file]) !== undefined && isSecretFile(`${dir}/${file}`, world),
  )
}

// Whether a resolved path names a credential file, a folder of them, or a wildcard that takes one in.
const isSecret = (path: string, world: World) => {
  if (isSecretFile(path, world) || SECRET_DIR.test(path) || HOME_DIRS.some(dir => path === norm(world.home) + dir)) {
    return true
  }

  if (!isWild(path)) {
    return false
  }

  const known = world.globs.get(path) ?? (path.length > MAX_GLOB || world.globs.size >= MAX_GLOBS || takesSecret(path, world) || takesListed(path, world))

  world.globs.set(path, known)

  return known
}

// The paths one word of a command names: -Path:x, --file=x and if=x name x, a,b and {a,b} name two.
// a.{b,c} is a.b and a.c; one level, which is how a pair of files is written.
const braced = (word: string) => {
  const found = /\{([^{},]*,[^{}]*)\}/.exec(word)

  return found === null ? [word] : (found[1] ?? '').split(',').map(one => word.slice(0, found.index) + one + word.slice(found.index + found[0].length))
}

const pathsOf = (word: string, world: World) =>
  braced(word.replace(/["']/g, '').replace(HOME_VAR, world.home))
    .flatMap(one => one.split(','))
    .map(one => one.replace(/^--?[\w-]+[=:](?![\\/])/, '').replace(/^\w+=/, '').replace(HOME_VAR, world.home).replace(/[{}]/g, ''))
    .filter(Boolean)
    .map(one => resolve(one, world))

const secretIn = (words: readonly string[], world: World) => words.flatMap(word => pathsOf(word, world)).find(path => isSecret(path, world))

// Programs that print what a file holds. Ones that only use a file (terraform -var-file, ssh -i, git, aws) or only look at
// it (ls, stat, Test-Path, wc) are not here.
// shortcut: an interpreter given its own code (python -c, node -e, openssl, tar then cat) is not followed beyond READ_CALL;
// no parser fixes that: for it, keep the files out of the account Claude runs as.
const READER = bin(
  'cat|tac|nl|rev|type|gc|Get-Content|head|tail|less|more|bat|base64|base32|xxd|od|hd|hexdump|strings|Format-Hex|certutil|cut|paste|fold|fmt|pr|expand|column|iconv|zcat|sort|uniq|diff|cmp|comm|dd|Import-Csv',
)
const GREP = bin('grep|egrep|rg')
// Their first plain argument is a pattern or script, not a file: `rg "\.tfvars" docs` searches for the name.
// perl and ruby are here for -pe and -ne, which print the files after the code.
const PATTERN_FIRST = bin('fgrep|ag|awk|gawk|jq|perl|ruby')
// Their options are whole words (-CaseSensitive), so no letter in one is a short flag.
const PS_PATTERN_FIRST = bin('findstr|Select-String|sls')
// An edit in place prints nothing.
const EDITOR = bin('sed|yq')
const isInPlace = (args: readonly string[]) => args.some(arg => /^(-i|--in-place)/.test(arg))
// By case: grep's -a, -b, -c and -F take no value, and one read as taking it let the file pass for the pattern. -T and -E take one
// only in rg, so they are left out.
const isRecursive = (args: readonly string[]) => args.some(arg => (/^-[a-zA-Z]+$/.test(arg) && /[rR]/.test(arg)) || /^--(dereference-)?recursive$/.test(arg))
const isValueFlag = (arg: string) =>
  /^(-[ABCmtgf]|--(after-context|before-context|context|max-count|type|type-not|glob|iglob|file))$/.test(arg) || /^-((literal)?path|context)$/i.test(arg)
const operands = (args: readonly string[], hasShortFlags = true) => {
  // -e KEY and -f patterns, alone or ending a cluster (-ie KEY), name the pattern in the next word.
  const flagged = args.findIndex(arg => (hasShortFlags && /^(-[a-zA-Z]*[ef]|--regexp|--file)$/.test(arg)) || /^-patt\w*$/i.test(arg))
  // The value of -A 2, -t md or -g '*.tf' is not the pattern; -g's stays, since it names files.
  const first = args.findIndex((arg, i) => !arg.startsWith('-') && !isValueFlag(args[i - 1] ?? ''))

  // Glued on (-eKEY, --file=x) the pattern is no word of its own, so every bare word is a file.
  return hasShortFlags && args.some(arg => /^(--(regexp|file)=|-[a-zA-Z]*[ef][^-])/.test(arg))
    ? args
    : args.filter((_, i) => i !== (flagged >= 0 ? flagged + 1 : first))
}

// The one read of a credential file that runs: its variable names, without the values.
const NAMES_PATTERN = /^\^(\[A-Za-z_\]\[A-Za-z0-9_\]\*|\\w\+)( \*)?=$/
const isNamesOnly = (args: readonly string[]) =>
  // -q, -c and -l answer whether or where, and print no line of the file. Before them in a cluster only flags that take no
  // value: in -esecret the c is part of the pattern.
  args.some(arg => /^(-[hHiInsvwxEFPz]*[qcl][a-zA-BD-Z]*|--quiet|--count|--files-with-matches)$/.test(arg)) ||
  (args.some(arg => /^-[EPh]*o[EPh]*$/.test(arg)) &&
    args.filter(arg => arg.startsWith('-')).every(arg => /^-[oEPh]+$/.test(arg)) &&
    NAMES_PATTERN.test(args.find(arg => !arg.startsWith('-')) ?? ''))

// A copy, move or link out of a credential file leaves the content where a later read finds it.
const COPIER = bin('cp|copy|Copy-Item|cpi|mv|move|Move-Item|mi|ren|Rename-Item|rni|ln|install|rsync|scp|xcopy|Compress-Archive')
// The copiers whose words come in another order, each put in cp's: sources first, the target last.
// robocopy src dst [files] /switches copies src\file to dst.
const robocopied = (args: readonly string[]) => {
  const [from = '', to = '', ...files] = args.filter(arg => !/^\/[a-z]+(:\S*)?$/i.test(arg))

  return [...(files.length > 0 ? files.map(file => `${from}/${file}`) : [from]), to]
}
// mklink [/d|/h|/j] link target names the link first.
const mklinked = (args: readonly string[]) => args.filter(arg => !/^\/[a-z]$/i.test(arg)).reverse()
const optionOf = (args: readonly string[], flag: RegExp) => {
  const at = args.findIndex(arg => flag.test(arg))

  return at < 0 ? undefined : args[at + 1]
}
// New-Item -ItemType SymbolicLink -Path link -Target file, or -Value:file; PowerShell takes any prefix of a name (-Val, -Tar).
const linked = (args: readonly string[]) => {
  const target = optionOf(args, /^-(t[arget]{0,5}|v[alue]{0,4})$/i) ?? args.find(arg => /^-(t[arget]{0,5}|v[alue]{0,4}):/i.test(arg))?.replace(/^-\w+:/, '')

  return target !== undefined && args.some(arg => /^(-\w+:)?(symboliclink|hardlink|junction)$/i.test(arg)) ? [target, optionOf(args, /^-(path|name)$/i) ?? ''] : []
}
// tar -czf out.tgz src (or tar czf, or --create --file=out.tgz): a create; - or no file is stdout.
// -r and -u add to an archive as -c makes one.
const tarred = (args: readonly string[]) => {
  const isFlags = (arg: string, i: number) => arg.startsWith('-') || i === 0

  if (!args.some((arg, i) => isFlags(arg, i) && (/^-?[A-Za-z]+$/.test(arg) ? /[cru]/.test(arg) : /^--(create|append|update)$/.test(arg)))) {
    return []
  }

  const at = args.findIndex((arg, i) => isFlags(arg, i) && /^(-?[A-Za-z]*f|--file)$/.test(arg))
  const file = args.find(arg => arg.startsWith('--file='))?.slice(7) ?? (at < 0 ? '-' : (args[at + 1] ?? '-'))

  return [...args.filter((arg, i) => !isFlags(arg, i) && (at < 0 || i !== at + 1)), file]
}
const copiedOut = (args: readonly string[], world: World) => {
  const flag = args.findIndex(arg => /^(-dest\w*|-t|--target-directory)$/i.test(arg))
  const words = args.filter((arg, i) => !/^-[\w-]+$/.test(arg) && (flag < 0 || i !== flag + 1))
  const to = flag >= 0 ? args[flag + 1] : (words.find(arg => /^-dest\w*:/i.test(arg)) ?? words.at(-1))
  const from = secretIn(words.filter(word => word !== to), world)

  // .env to .env.bak, or state to its backup, stays guarded where it lands.
  return from !== undefined && (to === undefined || secretIn([to], world) === undefined) ? from : undefined
}

// A file read by code handed to an interpreter: [IO.File]::ReadAllText, open(), readFileSync. In any case: PowerShell does not
// tell [IO.File]::readalltext from ReadAllText.
const READ_CALL =
  /ReadAll(Text|Bytes|Lines)|ReadLines|OpenText|OpenRead|StreamReader|ReadToEnd|readFileSync|readFile\b|createReadStream|\bopen\(|read_text|read_bytes|file_get_contents|(File|IO)\.read|\[(system\.)?io\.file(info)?\]::(copy|move|replace|open)/i

// A quoted run, or an escaped character outside one: matched too, so that \" opens no quote and a line of them is read once.
const QUOTED = /\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'[^']*'/g
const isEscape = (part: string) => part.startsWith('\\')
// What can stand before the program: an assignment, a keyword, a plain wrapper or a shell with its -c.
const SKIPPED =
  /^(\w+=.*|!|if|then|else|elif|do|while|until|sudo|doas|command|exec|time|nohup|winpty|cmd|\/[ck]|(ba|z|da|k)?sh|pwsh|powershell|-c|-command|-noprofile)(\.exe)?$/i
/** The command as statements, each a pipeline of stages, each the words of one call. A quoted argument is read as a command too. */
const statementsOf = (command: string, depth = 0): string[][][] => {
  const inner =
    depth < 3
      ? (command.match(QUOTED) ?? [])
          .filter(quoted => !isEscape(quoted))
          .map(quoted => quoted.slice(1, -1))
          // A substitution inside double quotes still runs.
          .filter(text => /\s|\$\(|`/.test(text))
          .flatMap(text => statementsOf(text, depth + 1))
      : []
  // Operators inside quotes are text; a redirection is no word of the call.
  const text = command
    .replace(QUOTED, quoted => (isEscape(quoted) ? quoted : quoted.replace(/[;|&\n(){}`<>]/g, ' ')))
    .replace(/(?<!\d)\d*>&\d|(?<!\d)\d*>>?\s*[^\s|;&]+/g, ' ')
    // export { a, b } is a line of JavaScript, or an error to bash: the brace is export's argument, so it is no bare export.
    .replace(/(?<![\w-])export[ \t]+\{/g, 'export \u0001')
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
// PowerShell readers that take piped items as files to open.
const PIPE_READER = /^(get-content|gc|select-string|sls|copy-item|cpi)$/
const LISTER = /^(find|fd|ls|dir|gci|get-childitem|get-item|gi|resolve-path|echo|printf|write-output)$/
// Every environment variable at once. One by name (printenv PATH, $env:PATH) runs.
const dumpsEnv = ([program, ...args]: readonly string[]) => {
  const name = nameOf(program)

  return (
    // cmd's `set AWS` prints every variable that starts AWS.
    (name === 'set' && (args.length === 0 || (args.length === 1 && /^\w+$/.test(args[0] ?? '')))) ||
    (/^(env|printenv|export|declare|typeset)$/.test(name) && args.every(arg => arg.startsWith('-') || (name === 'env' && /^\w+=/.test(arg)))) ||
    (/^(gci|ls|dir|get-childitem|get-item|gi|get-content|gc|type|cat)$/.test(name) &&
      args.some(arg => /^env:[\\/]?$/i.test(arg) || (/^env:[\\/]?\S*$/i.test(arg) && arg.includes('*'))))
  )
}
// Code handed to an interpreter that prints every variable. One by name (os.environ['X'], process.env.X) runs.
const ENV_CODE: readonly (readonly [RegExp, RegExp])[] = [
  [bin('python|python3|py'), /os\.environ(?!\s*\[|\.get\()/],
  [bin('node|deno|bun'), /process\.env(?![\w.[])|Deno\.env\.toObject/],
  [bin('ruby'), /\bENV\b(?!\s*\[|\.fetch)/],
  [bin('perl'), /%ENV/],
  [bin('awk|gawk'), /ENVIRON(?!\s*\[\s*")/],
  [bin('jq|yq'), /^\s*(\$ENV|env)\b(?!\.\w|\s*\[)/],
]
// shortcut: "names only" is read from the next stage's first words (cut -f1, wc, select Name), not proven; a longer pipeline
// that puts values back is not followed.
const NAMES_ONLY = /^(cut (?=.*-d ?=).*-f ?1( |$)|wc( |$)|(select|select-object|%|foreach-object) (-\w+ )*(name|key)$|measure)/i
// Runners the statement parser leaves at the front: aws-vault exec p -- env, op run -- env, sops exec-env f env, timeout 5 env,
// xargs env.
const RUNNER = /^(aws-vault|op|doppler|sops|timeout|xargs)$/
const unwrapped = (words: readonly string[]): readonly string[] => {
  let from = 0

  while (RUNNER.test(nameOf(words[from]))) {
    const dashes = words.indexOf('--', from + 1)
    const at = dashes > 0 ? dashes + 1 : words.findIndex((word, i) => i > from && /^(env|printenv|export|declare|typeset|set)$/.test(nameOf(word)))

    if (at < 0) {
      break
    }

    let next = at

    while (next < words.length && SKIPPED.test(words[next] ?? '')) {
      next++
    }

    from = next < words.length ? next : at
  }

  return from === 0 ? words : words.slice(from)
}

// One variable named for a credential: echo $GITHUB_TOKEN, $env:AWS_SECRET_ACCESS_KEY, printenv NPM_TOKEN.
// One used as another program's argument (curl -H "Authorization: Bearer $GITHUB_TOKEN") runs.
// The lookahead finds the word once; the name is then the whole run of word characters.
const SECRET_NAME = String.raw`(?=\w*(?:secret|token|password|passwd|api_?key|access_key|_key(?!\w)))\w+(?!\w)`
// The statement parser blanks a brace inside quotes: "${NPM_TOKEN}" reaches it as "$ NPM_TOKEN ".
const SECRET_VAR = new RegExp(String.raw`\$[{\s]?(?:env:)?${SECRET_NAME}|%${SECRET_NAME}%`, 'i')
const SECRET_ONLY = new RegExp(`^(env:[\\\\/]?)?${SECRET_NAME}$`, 'i')
const ENDS = String.raw`\s*(?:\|\s*(?<next>[^\s|;&]+)|(?=$|[;\n&}>]|\d>))`
// The variable, or [Environment]::GetEnvironmentVariable('NAME'), alone as a statement, in quotes or parentheses too
// ("$env:TOKEN", ($env:TOKEN)): PowerShell prints it, bash runs it and prints the value in its error. After a keyword
// (if ($env:TOKEN)) it is a test.
// A member or index on it prints it too: $env:TOKEN.ToString(), ($env:TOKEN).Trim(), $env:TOKEN[0..7]. Its .Length alone runs,
// as it did.
const MEMBERS = String.raw`(?!\.length(?![\w.[(]))(?:\.\w+(?:\([^()\n]*\))?|\[[^\]\n]*\])*`
const BARE_VAR = new RegExp(
  String.raw`(?:^|[;\n&{]|\|\|)[ \t]*(?:[("]+[ \t]*)?(?:\$\{?(?:env:)?${SECRET_NAME}\}?|%${SECRET_NAME}%|\[(?:system\.)?environment\]::getenvironmentvariable\(\s*['"]${SECRET_NAME}['"][^)]*\))${MEMBERS}\s*(?:[)"]+${MEMBERS}\s*)?${ENDS}`,
  'gi',
)
// A string alone as a statement is printed the same way: "token: $env:GITHUB_TOKEN". One with no space ("$KEY_DIR/run.sh") is
// more likely a program's path.
const BARE_STRING = new RegExp(String.raw`(?:^|[;\n&{]|\|\|)[ \t(]*"(?<text>[^"\n]*)"[ \t)]*${ENDS}`, 'g')
// Code handed to an interpreter that names one: os.environ['GITHUB_TOKEN'], process.env.GITHUB_TOKEN, $ENV{GITHUB_TOKEN}.
const CODE_RUNNER = bin(String.raw`python[\d.]*|py|node|nodejs|deno|bun|ruby|perl|php|awk|gawk|mawk|nawk`)
const NAMED_IN_CODE = new RegExp(
  String.raw`(?:(?<![$\w])(?:\w+\.)?env(?:iron)?(?:\.(?:get|fetch))?|getenv|\$ENV|\$_(?:ENV|SERVER))\s*[.[({]\s*['"]?${SECRET_NAME}`,
  'i',
)
// What prints what is piped into it; a program that takes it as a credential (gh auth login --with-token, docker login
// --password-stdin) does not.
const PRINTS_INPUT = [READER, GREP, PATTERN_FIRST, PS_PATTERN_FIRST, EDITOR, bin(String.raw`tee|tr|xargs|Out-\w+|Format-\w+|\w+-Object|select|where|\?|%`)]
const printsInput = (program = '') => PRINTS_INPUT.some(prints => prints.test(program))
const HERE_VAR = new RegExp(String.raw`<<<\s*(?:${SECRET_VAR.source})`, 'i')
const printsVar = (stages: readonly (readonly string[])[]) =>
  stages.some((stage, i) => {
    const [program = '', ...args] = unwrapped(stage)
    const name = nameOf(program)
    const prints =
      (/^(echo|printf|write|write-output|write-host|write-information)$/.test(name) && args.some(arg => SECRET_VAR.test(arg))) ||
      (/^(printenv|gci|ls|dir|get-childitem|get-item|gi|get-content|gc|type|cat)$/.test(name) &&
        args.some(arg => SECRET_ONLY.test(arg) && (name === 'printenv' || /^env:/i.test(arg)))) ||
      // declare -p NAME prints the one variable, value and all.
      (/^(declare|typeset|local|readonly|export)$/.test(name) && args.some(arg => /^-[a-zA-Z]*p/.test(arg)) && args.some(arg => SECRET_ONLY.test(arg))) ||
      // cat <<< $GITHUB_TOKEN hands it to a program that prints its input.
      (printsInput(program) && HERE_VAR.test(args.join(' ')))

    // Write-Host writes to the screen, whatever follows it.
    return prints && (i === stages.length - 1 || name === 'write-host' || printsInput(stages[i + 1]?.[0]))
  })

// Calls that send a file out: an upload, a request body, a gist, a commit. Each gives the words that name what it sends.
// @file, name=@file, file://x and fileb://x attach the file's content.
// curl's -F 'f=<file' sends the content as the field's value.
const ATTACHED = /^(--?[\w-]+=)?([\w.-]*=?[@<]|fileb?:\/\/)/i
const attached = (word: string) => word.replace(ATTACHED, '').replace(/;[\s\S]*$/, '')
// git's pathspec magic names the same file: ':(top).env', ':(glob)**/.env', ':/.env'. An exclude names what stays behind.
const pathspec = (arg: string) => {
  const [magic = ''] = /^:(\([^)]*\)|[/!^]+)/.exec(arg) ?? []

  return /exclude|[!^]/.test(magic) ? [] : [arg, arg.slice(magic.length)]
}
// The file an option names: -T x, --upload-file=x, -InFile:x.
const fileOf = (args: readonly string[], flag: RegExp) => args.flatMap((arg, i) => (flag.test(arg) ? [/[=:]/.test(arg) ? arg : (args[i + 1] ?? '')] : []))
const SENDERS: readonly (readonly [RegExp, (args: readonly string[]) => readonly string[]])[] = [
  // gist create .env and release upload send their files; issue/pr --body-file and -F, api -F x=@.env and --input send one.
  [
    bin('gh'),
    // A description or notes (-d "why .env is ignored") is no path.
    // An asset can carry a label: terraform.tfstate#state.
    args =>
      [...(says(args, / (gist (create|edit)|release (create|upload)) /) ? args.filter(arg => !/\s/.test(arg)) : []), ...fileOf(args, /^(--body-file|-F|--field|--input)([=:]|$)/)]
        .map(attached)
        .flatMap(file => [file, file.replace(/#[\s\S]*$/, '')]),
  ],
  [
    bin('curl'),
    args => [...args.filter(arg => ATTACHED.test(arg)).map(attached), ...fileOf(args, /^(-T|--upload-file)([=:]|$)/), ...args.filter(arg => /^-T./.test(arg)).map(arg => arg.slice(2))],
  ],
  [bin('wget'), args => fileOf(args, /^--(post|body)-file([=:]|$)/)],
  // -InF is as short as PowerShell takes it.
  [bin('Invoke-WebRequest|iwr|Invoke-RestMethod|irm'), args => fileOf(args, /^-InF[ile]{0,3}(:|$)/i)],
  // s3 cp .env s3://b sends what stands before the bucket; s3 cp s3://b/terraform.tfstate - prints the object.
  [
    bin('aws'),
    args => {
      const at = args.findIndex(arg => /^s3:\/\//i.test(arg))
      // --exclude .env names what stays behind.
      const local = args.slice(0, at).filter((_, i) => !/^--(exclude|include)$/.test(args[i - 1] ?? ''))
      const s3 = says(args, / s3 (cp|mv|sync) /) && at > 0 ? [...local, ...(args.includes('-') ? [args[at]?.slice(5) ?? ''] : [])] : []

      // s3api put-object --body .env sends the file too.
      return [...s3, ...args.filter(arg => /fileb?:\/\//i.test(arg)).map(attached), ...fileOf(args, /^--body([=:]|$)/)]
    },
  ],
  // A message (-m wip, -m "never commit .env") is no path; git rm --cached, status and check-ignore are no send.
  [
    bin('git'),
    args =>
      says(args, / (add|stage|commit) /)
        ? args.filter((arg, i) => !/\s/.test(arg) && !/^(-[a-zA-Z]*m|--(message|author|date))$/.test(args[i - 1] ?? '')).flatMap(pathspec)
        : [],
  ],
]
const sendDeny = (file: string) =>
  `this would send ${file} out with the call (an upload, a request body, a gist or a commit), where it is stored beyond your control. If it must go, ask the user to send it.`

// A recursive search from a folder that holds the home folder (C:\Users, C:\, /) walks into its credentials.
const aboveHome = (words: readonly string[], world: World) => {
  const home = norm(world.home)
  // c:, c:/users, c:/users/me: a wildcard that takes one of them in (/c/Users/*) is the same search.
  const above = home.split('/').map((_, i, parts) => [...parts.slice(0, i + 1).join('/')])

  return words
    .flatMap(word => pathsOf(word, world))
    .find(
      path =>
        path === '/' ||
        `${home}/`.startsWith(`${path}/`) ||
        (isWild(path) && path !== NOWHERE && !path.startsWith(`${NOWHERE}/`) && (path.length > MAX_GLOB || above.some(dir => witness(tokensOf(path), dir) !== undefined))),
    )
}
const searchDeny = (root: string) =>
  `this would search every file under ${root}, the credentials in your home folder among them, and put what matches ${WHERE} Search the project or a folder in it instead.`

// Calls that print a stored credential.
const says = (args: readonly string[], phrase: RegExp) => phrase.test(` ${args.filter(arg => !arg.startsWith('-')).join(' ')} `)
const PRINTERS: readonly (readonly [RegExp, (args: readonly string[]) => boolean])[] = [
  [
    bin('aws'),
    args =>
      says(
        args,
        / configure export-credentials | sts (get-session-token|get-federation-token|assume-role\S*|assume-root) | sso get-role-credentials | sso-oidc create-token | ecr(-public)? (get-login-password|get-authorization-token) | codeartifact get-authorization-token | eks get-token | rds generate-db-auth-token | secretsmanager (batch-)?get-secret-value | kms decrypt /,
      ) ||
      (says(args, / ssm get-parameters?(-by-path|-history)? /) && args.some(arg => /^--with-decryption(=|$)/.test(arg))) ||
      (says(args, / configure get /) && args.some(arg => /secret|token/i.test(arg))),
  ],
  // AWS Tools for PowerShell. EKS and RDS tokens have no cmdlet.
  [
    bin(
      'Get-SECSecretValue|Get-STSSessionToken|Get-STSFederationToken|Use-STSRole|Use-STSRoleWithSAML|Use-STSWebIdentityRole|Use-STSRoot|Get-ECRLoginCommand|Get-ECRAuthorizationToken|Get-CAAuthorizationToken|Get-SSORoleCredential|New-SSOOIDCToken|Invoke-KMSDecrypt',
    ),
    () => true,
  ],
  [bin('Get-SSMParameter|Get-SSMParameterValue|Get-SSMParametersByPath'), args => args.some(arg => /^-WithDecryption(:\$?true)?$/i.test(arg)) && !args.some(arg => /^\$false$/i.test(arg))],
  [bin('aws-vault'), args => says(args, /^ export /) || (says(args, /^ exec /) && args.includes('--json'))],
  [bin('op'), args => says(args, /^ read /) || (says(args, /^ item get /) && args.includes('--reveal'))],
  [bin('vault'), args => says(args, /^ (read|kv get|print token) /)],
  [bin('sops'), args => (args.some(arg => /^(-d|--decrypt)$/.test(arg)) || says(args, /^ decrypt /)) && !args.some(arg => /^(-i|--in-place|--output)(=|$)/.test(arg))],
  [
    bin('gh'),
    args => says(args, / auth (token|git-credential) /) || (says(args, / auth status /) && args.some(arg => /^(-t|--show-token)$/.test(arg))),
  ],
  [bin(String.raw`docker-credential-[\w-]+`), args => args.includes('get')],
  [bin('gpg|gpg2'), args => args.some(arg => /^--export-secret-(sub)?keys$/.test(arg))],
  [bin('git'), args => says(args, / credential(-[\w-]+)? (fill|get) /)],
  // output -json and -raw print sensitive outputs in full; show -json prints the state or plan with its secrets.
  [
    bin('terraform|tofu|terragrunt'),
    args =>
      says(args, / state pull /) ||
      (says(args, / output /) && args.some(arg => /^--?(json|raw)(=(?!(false|0)$)[\s\S]*)?$/.test(arg))) ||
      (says(args, / show /) && args.some(arg => /^--?json(=(?!(false|0)$)[\s\S]*)?$/.test(arg))),
  ],
  [bin('gcloud'), args => says(args, / print-(access|identity)-token /)],
  [bin('az'), args => says(args, / account get-access-token /)],
  [
    bin('kubectl|oc'),
    args =>
      (says(args, / config view /) && args.some(arg => /^--(raw|flatten)/.test(arg))) ||
      // A secret among several kinds (get cm,secret), in any case (get Secret), and any output that prints its data
      // (custom-columns=D:.data).
      (says(args, / get /) &&
        args.some(arg => /(^|,)secrets?([/,.]|$)/i.test(arg)) &&
        / (-o|--output)[= ]?(yaml|json|jsonpath|go-template|custom-columns)| --template/.test(` ${args.join(' ')}`)),
  ],
]
// aws ecr get-login-password | docker login --password-stdin hands the token to docker, not the conversation. Only when login
// is the program's own command and nothing after it can run or redirect (docker run ... sh -c "cat # login --password-stdin"
// is no login); each stretch is bounded, so a long line is read once and one past the bounds is not let through.
const PIPED_LOGIN =
  /(?:(?<![\w-])aws(?:\.exe)?\s[^|;&\n]{0,200}?\becr(?:-public)?\s+get-login-password|Get-ECRLoginCommand)[^|;&\n]{0,200}?\|\s*(?:(?:docker|podman|nerdctl|finch|oras)(?:\.exe)?|helm(?:\.exe)?\s+registry)\s+login\s[^|;&\n()\x60#]{0,300}?--password-stdin(?![\w-])[^|;&\n()\x60#]{0,300}?(?=\s*(?:$|[;&\n|]))/gi

const WHERE = 'into the conversation, where it is sent to the API, saved in transcripts and can end up in a commit or a command.'
const INSTEAD = String.raw`Ask the user for the one value you need, or read the variable names only: grep -oE '^\w+ *=' <file>, or the file's .example copy.`
const fileDeny = (file: string, how = 'this would put') => `${how} ${file} ${WHERE} ${INSTEAD}`

// shortcut: a path is found only as written (whole, with ~ or a home variable, or as a wildcard); one built from pieces
// (Join-Path), read through a symlink or an 8.3 short name, or by a script file that opens it, slips past.
/** Why the command would put a secret into the conversation, or undefined. */
const finding = (command: string, world: World): string | undefined => {
  // rg x C:\Users, grep -r x /c/Users: a search of whole folders. After a cd, one that names no folder searches the folder
  // moved to: cd ~ && rg aws_secret.
  const searches = [...invocations(command, bin('rg')), ...invocations(command, bin('grep|egrep|fgrep')).filter(isRecursive)]
    // rg -l and --count print names and counts, not lines.
    .filter(args => !isNamesOnly(args))
    .map(args => operands(args))
    .map(named => (world.moved && named.every(arg => arg.startsWith('-')) ? [...named, '.'] : named))
  const readers = [
    ...(world.moved ? searches : []),
    ...invocations(command, READER),
    ...invocations(command, GREP)
      .filter(args => !isNamesOnly(args))
      .map(args => operands(args)),
    ...invocations(command, PATTERN_FIRST).map(args => operands(args)),
    ...invocations(command, PS_PATTERN_FIRST).map(args => operands(args, false)),
    ...invocations(command, EDITOR)
      .filter(args => !isInPlace(args))
      .map(args => operands(args)),
  ]
  const statements = statementsOf(command)
  // cat {.env,app.json}, cp .env{,.txt}: the shared parser ends a word at a brace, so brace words are read from the command.
  const braces = command.split(/[\s;|&()<>`"']+/).filter(word => /\{[^{},]*,[^{}]*\}/.test(word))
  const copies = [
    ...invocations(command, COPIER),
    ...invocations(command, bin('robocopy')).map(robocopied),
    ...invocations(command, bin('mklink')).map(mklinked),
    ...invocations(command, bin('New-Item|ni')).map(linked),
    ...invocations(command, bin('tar|bsdtar')).map(tarred),
  ].filter(args => args.length > 0)
  const read =
    readers.map(args => secretIn(args, world)).find(Boolean) ??
    [...copies, ...(copies.length > 0 ? braces.map(braced) : [])].map(args => copiedOut(args, world)).find(Boolean) ??
    // cat < .env, cat 0<.env, cat <>.env, $(< key.pem): the file reaches the program without being its argument. A < in quotes
    // is text, but for the one that opens a substitution: "$(<.env)".
    secretIn(
      [...command.replace(QUOTED, quoted => quoted.replace(/(?<!(?:\$\(|\x60)\s*)</g, ' ')).matchAll(/(?<!<)<(?![<(&])>?\s*([^\s<>|;&()\x60]+)/g)].map(
        ([, file = '']) => file,
      ),
      world,
    ) ??
    (READ_CALL.test(command) ? secretIn(command.split(/[\s;|&()<>`,[\]"']+/), world) : undefined) ??
    (readers.length > 0 ? secretIn(braces, world) : undefined)

  if (read !== undefined) {
    return fileDeny(read)
  }

  // cat $(find . -name .env), gc (ls *.tfvars): a lister in a substitution puts its names on the reader's command line.
  const substituted = [...command.matchAll(/(?:\$|\s)\(([^()]*)\)|`([^`]*)`/g)].flatMap(([, body, ticked]) => statementsOf(body ?? ticked ?? ''))
  const listers = [
    ...statements
      // The names must be handed on as files: find | sort and ls | grep only read the list.
      .filter(
        stages =>
          stages.flat().some(word => /^(-exec\w*|xargs|%|foreach-object|foreach|\$_)$/i.test(word)) ||
          stages.some(([program]) => PIPE_READER.test(nameOf(program))),
      ),
    ...substituted,
  ].flatMap(stages => stages.filter(([program]) => LISTER.test(nameOf(program))))
  const fed = listers.map(words => secretIn(words.slice(1), world)).find(Boolean)
  // A search from above the home folder, gci -Recurse C:\ | sls x too.
  const searched =
    searches.map(named => aboveHome(named, world)).find(Boolean) ??
    (readers.length > 0
      ? listers
          .filter(
            ([program, ...args]) =>
              /^(find|fd)$/.test(nameOf(program)) ||
              args.some(arg => (/^-[a-zA-Z]+$/.test(arg) && arg.includes('R')) || arg === '--recursive' || /^(-r|-recurse|\/s)$/i.test(arg)),
          )
          .map(words => aboveHome(words.slice(1), world))
          .find(Boolean)
      : undefined)

  if (searched !== undefined) {
    return searchDeny(searched)
  }

  // f=.env; cat $f and for f in .env*; do cat "$f": the reader is handed the file through a variable.
  const bound = secretIn(
    [...command.matchAll(/(?:^|[\s;({])\$?\w+\s*=\s*([^\s;|&)]+)|\b(?:for|foreach)\s*(?:\(\s*)?\$?\w+\s+in\s+([^;)\n]+)/gi)].flatMap(
      ([, value, list]) => (value ?? list ?? '').split(/\s+/),
    ),
    world,
  )
  const handed = (fed !== undefined && readers.length > 0 ? fed : undefined) ?? (readers.some(args => args.some(arg => /\$\{?\w/.test(arg))) ? bound : undefined)

  if (handed !== undefined) {
    return fileDeny(handed, 'this hands a program that prints it')
  }

  const sent = SENDERS.flatMap(([program, files]) => invocations(command, program).map(args => secretIn(files(args), world))).find(Boolean)

  if (sent !== undefined) {
    return sendDeny(sent)
  }

  if (
    statements.some(stages => stages.some((stage, i) => dumpsEnv(unwrapped(stage)) && !NAMES_ONLY.test((stages[i + 1] ?? []).join(' ')))) ||
    /GetEnvironmentVariables/i.test(command) ||
    ENV_CODE.some(([program, dumps]) => invocations(command, program).some(args => args.some(arg => dumps.test(arg))))
  ) {
    return `this would put every environment variable, tokens and keys among them, ${WHERE} Read one variable by name (printenv NAME, $env:NAME), or list the names only: env | cut -d= -f1.`
  }

  // echo "TOKEN=$TOKEN" >> .env, one statement, writes it where the guard still covers it.
  const intoSecret =
    statements.length === 1 && secretIn([...command.matchAll(/(?<![2-9&])>>?\s*([^\s|;&<>]+)/g)].map(([, file = '']) => file), world) !== undefined

  const isPrinted = ({ groups }: RegExpMatchArray) => groups?.next === undefined || printsInput(groups.next)
  // The command a shell is handed is read for a bare variable too: pwsh -c '$env:GITHUB_TOKEN'.
  const scripts = [
    ...command.matchAll(/(?<![\w-])(?:pwsh|powershell|bash|sh|zsh|dash|cmd)(?:\.exe)?(?:\s+[-/]\w+){1,6}\s+(?:"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|([^\s"'-]\S*))/gi),
  ].map(
    ([, double, single, plain]) => double ?? single ?? plain ?? '',
  )

  if (
    !intoSecret &&
    // ${NAME} is read as $NAME as well: to the statement parser its braces end a statement.
    ([...statements, ...statementsOf(command.replace(/\$\{([^{}]*)\}/g, '$$$1'))].some(printsVar) ||
      [command, ...scripts].some(text => [...text.matchAll(BARE_VAR)].some(isPrinted)) ||
      [...command.matchAll(BARE_STRING)].some(found => /\s/.test(found.groups?.text ?? '') && SECRET_VAR.test(found.groups?.text ?? '') && isPrinted(found)) ||
      invocations(command, CODE_RUNNER).some(args => args.some(arg => NAMED_IN_CODE.test(arg))))
  ) {
    return `this would put the value of a variable named for a credential ${WHERE} Hand it to the program that needs it ("$NAME" as its argument, or piped to its --with-token or --password-stdin) instead of printing it.`
  }

  const printable = command.replace(PIPED_LOGIN, ' ')
  // aws-vault and op are wrappers to the shared parser, which hands back only the program they run: their own calls are read
  // from the statements.
  const runners = statementsOf(printable)
    .flat()
    .filter(([name]) => RUNNER.test(nameOf(name)))

  return PRINTERS.some(
    ([program, prints]) => invocations(printable, program).some(prints) || runners.some(([name = '', ...args]) => program.test(name) && prints(args)),
  )
    ? `this would put a stored credential ${WHERE} A program that needs the credential reads it itself; if you need the value, ask the user.`
    : undefined
}

// SECRET_READ_ALLOW: a glob with no folder matches the name anywhere; one with folders matches the end of the path.
const worldOf = (cwd: string, home: string, allowed = ''): World => ({
  cwd,
  home,
  globs: new Map(),
  asked: new Set(),
  allow: allowed
    .split(',')
    .map(glob => glob.trim())
    .filter(Boolean)
    .map(glob => new RegExp(`(^|/)${globSource(norm(glob.replace(HOME_VAR, home)))}$`)),
})

// A quoted heredoc handed to cat, tee or git commit/tag is text it writes, not commands: cat > notes.md <<'EOF'. Only when it is
// the whole command: a plain opening line (no $, \, #, open quote, operator or other <) and nothing after the end line. The rest
// of heredocs, unquoted ones included, are read as written.
const PLAIN_WORDS = String.raw`(?:[ \t]+(?:\d?>>?[ \t]*)?(?:[^\s$\\#|&;()<>\x60'"]|'[^'\n]*'|"[^"\n$\x60\\]*")+)*`
const DATA_HEREDOC = new RegExp(
  String.raw`^(?:cat|tee|git(?:[ \t]+(?:-[Cc][ \t]+[^\s$\\#|&;()<>\x60'"]+|--[\w-]+))*[ \t]+(?:commit|tag))${PLAIN_WORDS}[ \t]*<<(-?)[ \t]*(?:'(\w+)'|"(\w+)"|\\(\w+))${PLAIN_WORDS}[ \t]*\n`,
)
const withoutText = (command: string) => {
  const [opening = '', dash, ...tags] = DATA_HEREDOC.exec(command) ?? []
  const tag = tags.find(Boolean)
  const lines = command.slice(opening.length).split('\n')
  // The body ends at the first line that is the tag (<<- strips tabs only).
  const body = lines.map(line => (dash ? line.replace(/^\t+/, '') : line))
  const end = body.indexOf(tag ?? '')
  // A line that is the tag but for spaces or control characters (EOF\r ends it in Cygwin's bash) may end it elsewhere: give up.
  const isUnclear = command.includes('\r') || body.slice(0, end + 1).some(line => line !== tag && line.replace(/^[\s\x00-\x1f]+|(?<![\s\x00-\x1f])[\s\x00-\x1f]+$/g, '') === tag)

  // Written to a device (> /dev/stdin, /proc/self/fd/0) it may reach something that reads it as commands.
  return tag !== undefined && end >= 0 && !isUnclear && lines.slice(end + 1).join('\n').trim() === '' && !/(dev|proc)\//.test(opening)
    ? `${opening}${lines[end]}`
    : command
}
// The terminal tool types into the user's own shell, which may not be bash and may run each line.
const TERMINAL = 'mcp__terminal__run_in_terminal'
// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', TERMINAL]
// shortcut: any other MCP tool that runs a command is not read; deny it by name in managed settings (permissions.deny) or add it here.

// The folders a cd, Set-Location, pushd or chdir in the command leads to: a name after it is read in each, since which
// one applies to which read is not followed. One that cannot be resolved (cd $DIR, cd "$(...)", cd -) is NOWHERE. A bare cd
// is the home folder to bash and PowerShell 7, and NOWHERE as well, as it was.
// shortcut: git -C, env -C, make -C and Start-Process -WorkingDirectory are not followed; add them if one is seen in use.
const MOVER = bin('cd|chdir|pushd|Set-Location|sl|Push-Location')
const MOVES = /(?<![\w-])(cd|chdir|pushd|set-location|sl|push-location)(?![\w-])/i
const HOME_ANYWHERE = new RegExp(HOME_VAR.source.slice(1), 'gi')
const MAX_MOVES = 8
const worldsOf = (command: string, world: World): World[] => {
  const moves = invocations(command, MOVER)

  if (moves.length === 0) {
    return [world]
  }

  const isLost =
    moves.length > MAX_MOVES ||
    moves.some(args => args.includes(DYNAMIC) || args.every(arg => arg.trim() === '')) ||
    command
      .replace(HOME_ANYWHERE, '')
      .split(/[\n;|&]/)
      .some(part => MOVES.test(part) && /[$\x60(%]|(^|\s)["']?(-|~\S+)["']?(\s|$)/.test(part))
  const targets = moves.slice(0, MAX_MOVES).map(args => (args.length === 0 ? ['~'] : args.slice(0, 4)))
  const dirs = new Set<string>()
  let from = [world.cwd]

  // cd ~ && cd .aws: each move is tried from where the ones before it led, in any order for three moves.
  for (let round = 0; round < Math.min(moves.length, 3); round++) {
    from = from.flatMap(cwd => targets.flatMap(args => args.flatMap(arg => pathsOf(arg, { ...world, cwd })))).filter(dir => !dirs.has(dir))
    from.slice(0, 2 * MAX_MOVES - dirs.size).forEach(dir => dirs.add(dir))
  }

  // A longer chain is followed one move after the other. The parser hands the calls back last first; both orders are walked,
  // so that this holds whichever way it does.
  for (const chain of [[...targets].reverse(), targets]) {
    let at = [world.cwd]

    for (const args of chain) {
      const next = [...new Set(at.flatMap(cwd => args.flatMap(arg => pathsOf(arg, { ...world, cwd }))))].slice(0, 4)

      at = next.length > 0 ? next : at
      at.forEach(dir => dirs.add(dir))
    }
  }

  return [world, ...[...dirs, ...(isLost ? [NOWHERE] : [])].map(cwd => ({ ...world, cwd, moved: true }))]
}

/** Why a tool's command would put a secret into the conversation, or undefined. The command is read every way a shell could read it. */
const denial = (tool: string, written: string, world: World): string | undefined => {
  const why = unreadable(written)

  if (why !== undefined) {
    return `${why}, so it cannot be checked for a credential read. Run it as shorter commands.`
  }

  const texts = new Set([tool === TERMINAL ? written : withoutText(written)])
  const also = (rewrite: (text: string) => string) => [...texts].forEach(text => texts.add(rewrite(text)))
  // A heredoc's body, and a here-string, as the commands or the arguments of whatever is handed them: xargs cat <<EOF, cmd <<EOF,
  // . /dev/stdin <<EOF, eval "$(cat <<'EOF' ...)". The shared parser reads a body as text unless a shell is named on its line;
  // only the text withoutText took out above is known to be text.
  const unfolded = (text: string) => text.replace(/<<</g, ' ').replace(/(?<!<)<<-?[ \t]*[^\s|;&()<>]*/g, ' ')

  also(unfolded)
  also(text => (/<</.test(text) && /(?<![\w-])(xargs|parallel)(?![\w-])/.test(text) ? unfolded(text).replace(/\n/g, ' ') : text))

  // Bash drops a backslash outside quotes (cat .e\nv and cat id\_rsa name .env and id_rsa); only PowerShell is known not to.
  if (tool !== 'PowerShell') {
    also(text => text.replace(QUOTED, part => (isEscape(part) ? part.slice(1).replace('\n', '') : part)))
  }

  // PowerShell drops a backtick (gc `.env), and to it a backslash does not escape a quote: "a\" is a whole string.
  also(text => text.replace(/`/g, ''))

  if (tool === 'PowerShell' || tool === TERMINAL) {
    also(text => text.replace(/\\(?=["'])/g, '/'))
  }

  for (const text of texts) {
    for (const one of worldsOf(text, world)) {
      const found = finding(text, one)

      if (found !== undefined) {
        return found
      }
    }
  }

  return undefined
}

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: ['Read', 'Grep'] }, async ($, e, next) => {
    const world = worldOf(await $.session.cwd(), (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~', await $.env.get('SECRET_READ_ALLOW'))
    // A Grep glob is matched under its path.
    const secret =
      e.tool === 'Read'
        ? secretIn([e.file_path], world)
        : (secretIn([e.path ?? ''].filter(Boolean), world) ??
          secretIn((e.glob ?? '').split(/\s+/).filter(Boolean), { ...world, cwd: resolve(e.path ?? '.', world) }))

    // Grep searches its whole path: one above the home folder walks into it.
    const above = e.tool === 'Grep' ? aboveHome([e.path ?? '.'], world) : undefined

    return secret !== undefined
      ? { deny: `${$.plugin.name}: ${fileDeny(secret)}` }
      : above !== undefined
        ? { deny: `${$.plugin.name}: ${searchDeny(above)}` }
        : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))

  on('tool.call', { tool: SHELL_TOOLS }, async ($, e, next) => {
    // A Monitor that opens a WebSocket has no command.
    const written = String((e as { command?: unknown }).command ?? '')
    const cwd = await $.session.cwd()
    const world = { ...worldOf(cwd, (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~', await $.env.get('SECRET_READ_ALLOW')), dots: e.tool === 'PowerShell' || e.tool === TERMINAL }
    let found = denial(e.tool, written, world)

    if (found === undefined && world.asked.size > MAX_LISTED) {
      found = 'it names wildcards in more folders than are checked for a credential file. Run it as shorter commands.'
    } else if (found === undefined && world.asked.size > 0) {
      // A folder that is not there, or cannot be listed, holds nothing to this check: the wildcard is judged by its text alone, as before.
      // shortcut: a path is lower-cased when resolved, so on a case-sensitive disk only the working folder and lower-case
      // folders are listed; keep the written case if that bites.
      // The call is written whole, $.fs.list(: the host lets a mod make only the calls it finds in its source.
      const list = async (dir: string) => {
        try {
          return (await $.fs.list(dir === norm(cwd) ? cwd : dir)).map(entry => entry.name.toLowerCase())
        } catch {
          return []
        }
      }
      const files = new Map(await Promise.all([...world.asked].map(async dir => [dir, await list(dir)] as const)))

      found = denial(e.tool, written, { ...world, files, globs: new Map() })
    }

    return found === undefined ? next(e) : { deny: `${$.plugin.name}: ${found}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))
}
