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
    // .env, .env.local, .env-prod, .envrc and prod.env; not .environment.md.
    String.raw`(^|/)[^/]*\.env(rc|[._-][^/]*)?$`,
    // Every variable of a process, as a file.
    String.raw`^/proc/[^/]+/environ$`,
    String.raw`/\.aws/(credentials|(sso|cli|login)/cache/[^/]+)$`,
    // A private key in ~/.ssh can have any name; the files beside it that hold none are known.
    String.raw`(^|/)(\.ssh/(?!(config|known_hosts[^/]*|authorized_keys)$)[^/]+|id_(rsa|dsa|ecdsa|ed25519)[^/]*)$`,
    String.raw`\.(pem|key|p12|pfx|ppk|jks|keystore)$`,
    String.raw`\.tfstate(\.[^/]*backup)?$`,
    String.raw`\.tfvars(\.json)?$`,
    String.raw`(^|/)(\.npmrc|\.netrc|_netrc|\.pypirc|\.pgpass|\.git-credentials|\.terraformrc|terraform\.rc|credentials\.tfrc\.json|\.vault-token)$`,
    String.raw`/\.docker/config\.json$`,
    // kubeconfigs under any name, and the exec plugins' token caches.
    String.raw`/\.kube/.`,
    String.raw`/(gh|github cli)/hosts\.yml$`,
    String.raw`/\.config/git/credentials$`,
    String.raw`/\.azure/(msal_token_cache[^/]*|accesstokens\.json|service_principal_entries[^/]*|azurermcontext\.json|tokencache\.dat)$`,
    String.raw`/\.identityservice/msal\.cache[^/]*$`,
    String.raw`/gcloud/(credentials\.db|access_tokens\.db|application_default_credentials\.json|legacy_credentials/.*)$`,
    // Service-account keys: by name, or as the console names them (project-0123456789ab.json).
    String.raw`(^|/)([^/]*service[-_]?account|([^/]*[-_.])?sa[-_]key)[^/]*\.json$`,
    String.raw`-[0-9a-f]{12}\.json$`,
    String.raw`/\.codex/auth\.json$`,
    String.raw`/\.claude/\.credentials\.json$`,
    // MCP servers' tokens and the account's own; a project's .mcp.json is left readable, as projects commit it.
    String.raw`(^|/)\.claude\.json(\.backup[^/]*)?$`,
  ].join('|'),
)
// A public key, and the committed stand-ins that hold names but no values.
const NOT_SECRET = /\.(pub|example|sample|template)$/
// Folders that hold little else: a search or copy of the whole folder reads the credential.
const SECRET_DIR =
  /\/(\.ssh|\.aws|\.aws\/(sso|login)|\.aws\/(sso|cli|login)\/cache|\.azure|\.identityservice|\.kube|\.docker|\.config|\.config\/(gcloud|gh|git)|appdata\/roaming|appdata\/roaming\/(gcloud|github cli))$/

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
  '.claude.json',
  '.config/git/credentials',
]
const PROJECT_FILES = ['.env', '.env.local', '.envrc', '.npmrc', 'terraform.tfstate', 'terraform.tfvars', 'id_rsa']

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
  if (isSecretFile(path, world) || SECRET_DIR.test(path) || path === norm(world.home)) {
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
// a.{b,c} is a.b and a.c; one level, which is how a pair of files is written.
const braced = (word: string) => {
  const [, before = '', list = '', after = ''] = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(word) ?? []

  return list === '' ? [word] : list.split(',').map(one => before + one + after)
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
// New-Item -ItemType SymbolicLink -Path link -Target file.
const linked = (args: readonly string[]) => {
  const target = optionOf(args, /^-(target|value)$/i)

  return target !== undefined && args.some(arg => /^(-itemtype:)?(symboliclink|hardlink|junction)$/i.test(arg)) ? [target, optionOf(args, /^-(path|name)$/i) ?? ''] : []
}
// tar -czf out.tgz src (or tar czf, or --create --file=out.tgz): a create; - or no file is stdout.
const tarred = (args: readonly string[]) => {
  const isFlags = (arg: string, i: number) => arg.startsWith('-') || i === 0

  if (!args.some((arg, i) => isFlags(arg, i) && /^(-?[A-Za-z]*c[A-Za-z]*|--create)$/.test(arg))) {
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

// A file read by code handed to an interpreter: [IO.File]::ReadAllText, open(), readFileSync.
const READ_CALL =
  /ReadAll(Text|Bytes|Lines)|ReadLines|OpenText|OpenRead|StreamReader|ReadToEnd|readFileSync|readFile\b|createReadStream|\bopen\(|read_text|read_bytes|file_get_contents|(File|IO)\.read/

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
    (/^(gci|ls|dir|get-childitem|get-item|gi|get-content|gc|type|cat)$/.test(name) && args.some(arg => /^env:[\\/]?(\S*\*\S*)?$/i.test(arg)))
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
// Runners the statement parser leaves at the front: aws-vault exec p -- env, op run -- env, timeout 5 env, xargs env.
const RUNNER = /^(aws-vault|op|doppler|timeout|xargs)$/
const unwrapped = (words: readonly string[]): readonly string[] => {
  if (!RUNNER.test(nameOf(words[0]))) {
    return words
  }

  const dashes = words.indexOf('--')
  const at = dashes > 0 ? dashes + 1 : words.findIndex(word => /^(env|printenv|export|declare|typeset|set)$/.test(nameOf(word)))
  const rest = at > 0 ? words.slice(at) : []

  return at > 0 ? unwrapped(rest.slice(Math.max(0, rest.findIndex(word => !SKIPPED.test(word))))) : words
}

// One variable named for a credential: echo $GITHUB_TOKEN, $env:AWS_SECRET_ACCESS_KEY, printenv NPM_TOKEN.
// One used as another program's argument (curl -H "Authorization: Bearer $GITHUB_TOKEN") runs.
const SECRET_NAME = String.raw`(?:\w*(?:secret|token|password|passwd|api_?key|access_key)\w*|\w*_key)(?!\w)`
// The statement parser blanks a brace inside quotes: "${NPM_TOKEN}" reaches it as "$ NPM_TOKEN ".
const SECRET_VAR = new RegExp(String.raw`\$[{\s]?(?:env:)?${SECRET_NAME}|%${SECRET_NAME}%`, 'i')
const SECRET_ONLY = new RegExp(`^(env:[\\\\/]?)?${SECRET_NAME}$`, 'i')
// The variable, or [Environment]::GetEnvironmentVariable('NAME'), alone as a statement: PowerShell prints it, bash runs it and
// prints the value in its error. Inside parentheses (if ($env:TOKEN)) it is a test.
const BARE_VAR = new RegExp(
  String.raw`(?:^|[;\n&{]|\|\|)\s*(?:\$\{?(?:env:)?${SECRET_NAME}\}?|%${SECRET_NAME}%|\[(?:system\.)?environment\]::getenvironmentvariable\(\s*['"]${SECRET_NAME}['"][^)]*\))\s*(?:\|\s*(?<next>[^\s|;&]+)|(?=$|[;\n&}>]|\d>))`,
  'gi',
)
// What prints what is piped into it; a program that takes it as a credential (gh auth login --with-token, docker login
// --password-stdin) does not.
const printsInput = (program = '') =>
  [READER, GREP, PATTERN_FIRST, PS_PATTERN_FIRST, EDITOR, bin(String.raw`tee|tr|xargs|Out-\w+|Format-\w+`)].some(prints => prints.test(program))
const printsVar = (stages: readonly (readonly string[])[]) =>
  stages.some((stage, i) => {
    const [program, ...args] = unwrapped(stage)
    const name = nameOf(program)
    const prints =
      (/^(echo|printf|write|write-output|write-host|write-information)$/.test(name) && args.some(arg => SECRET_VAR.test(arg))) ||
      (/^(printenv|gci|ls|dir|get-childitem|get-item|gi|get-content|gc|type|cat)$/.test(name) &&
        args.some(arg => SECRET_ONLY.test(arg) && (name === 'printenv' || /^env:/i.test(arg))))

    return prints && (i === stages.length - 1 || printsInput(stages[i + 1]?.[0]))
  })

// Calls that send a file out: an upload, a request body, a gist, a commit. Each gives the words that name what it sends.
// @file, name=@file, file://x and fileb://x attach the file's content.
const ATTACHED = /^(--?[\w-]+=)?([\w.-]*=?@|fileb?:\/\/)/i
const attached = (word: string) => word.replace(ATTACHED, '').replace(/;.*$/, '')
// The file an option names: -T x, --upload-file=x, -InFile:x.
const fileOf = (args: readonly string[], flag: RegExp) => args.flatMap((arg, i) => (flag.test(arg) ? [/[=:]/.test(arg) ? arg : (args[i + 1] ?? '')] : []))
const SENDERS: readonly (readonly [RegExp, (args: readonly string[]) => readonly string[]])[] = [
  // gist create .env, issue comment --body-file .env, release upload, api -F x=@.env and --input .env.
  [bin('gh'), args => (says(args, / (gist|issue|pr|release|api) /) ? args.map(attached) : [])],
  [bin('curl'), args => [...args.filter(arg => ATTACHED.test(arg)).map(attached), ...fileOf(args, /^(-T|--upload-file)([=:]|$)/)]],
  [bin('wget'), args => fileOf(args, /^--(post|body)-file([=:]|$)/)],
  [bin('Invoke-WebRequest|iwr|Invoke-RestMethod|irm'), args => fileOf(args, /^-InFile(:|$)/i)],
  // s3 cp .env s3://b sends what stands before the bucket; s3 cp s3://b/terraform.tfstate - prints the object.
  [
    bin('aws'),
    args => {
      const at = args.findIndex(arg => /^s3:\/\//i.test(arg))
      const s3 = says(args, / s3 (cp|mv|sync) /) && at > 0 ? [...args.slice(0, at), ...(args.includes('-') ? [args[at]?.slice(5) ?? ''] : [])] : []

      return [...s3, ...args.filter(arg => /fileb?:\/\//i.test(arg)).map(attached)]
    },
  ],
  // A message (-m "never commit .env") is no path; git rm --cached, status and check-ignore are no send.
  [bin('git'), args => (says(args, / (add|stage|commit) /) ? args.filter((_, i) => !/^(-[a-zA-Z]*m|--(message|author|date))$/.test(args[i - 1] ?? '')) : [])],
]
const sendDeny = (file: string) =>
  `this would send ${file} out with the call (an upload, a request body, a gist or a commit), where it is stored beyond your control. If it must go, ask the user to send it.`

// A recursive search from a folder that holds the home folder (C:\Users, C:\, /) walks into its credentials.
const aboveHome = (words: readonly string[], world: World) => {
  const home = `${norm(world.home)}/`

  return words.flatMap(word => pathsOf(word, world)).find(path => path === '/' || home.startsWith(`${path}/`))
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
        / configure export-credentials | sts (get-session-token|get-federation-token|assume-role\S*|assume-root) | sso get-role-credentials | sso-oidc create-token | ecr(-public)? (get-login-password|get-authorization-token) | codeartifact get-authorization-token | eks get-token | rds generate-db-auth-token | secretsmanager get-secret-value | kms decrypt /,
      ) ||
      (says(args, / ssm get-parameters?(-by-path)? /) && args.includes('--with-decryption')) ||
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
  [bin('sops'), args => (args.some(arg => /^(-d|--decrypt)$/.test(arg)) || says(args, /^ decrypt /)) && !args.some(arg => /^(-i|--in-place|--output)/.test(arg))],
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
      (says(args, / output /) && args.some(arg => /^--?(json|raw)$/.test(arg))) ||
      (says(args, / show /) && args.some(arg => /^--?json$/.test(arg))),
  ],
  [bin('gcloud'), args => says(args, / print-(access|identity)-token /)],
  [bin('az'), args => says(args, / account get-access-token /)],
  [
    bin('kubectl|oc'),
    args =>
      (says(args, / config view /) && args.some(arg => /^--(raw|flatten)/.test(arg))) ||
      (says(args, / get secrets?( |\/)/) && / (-o|--output)[= ]?(yaml|json|jsonpath|go-template)| --template/.test(` ${args.join(' ')}`)),
  ],
]
// aws ecr get-login-password | docker login --password-stdin hands the token to docker, not the conversation.
const PIPED_LOGIN = /(\S*aws(\.exe)?\s[^|;&\n]*\becr(-public)?\s+get-login-password|Get-ECRLoginCommand)[^|;&\n]*\|\s*[^|;&\n]*\blogin\b[^|;&\n]*--password-stdin/gi

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
      .map(args => operands(args)),
    ...invocations(command, PATTERN_FIRST).map(args => operands(args)),
    ...invocations(command, PS_PATTERN_FIRST).map(args => operands(args, false)),
    ...invocations(command, EDITOR)
      .filter(args => !isInPlace(args))
      .map(args => operands(args)),
  ]
  const statements = statementsOf(command)
  // cat {.env,app.json}, cp .env{,.txt}: the shared parser ends a word at a brace, so brace words are read from the command.
  const braces = command.match(/[^\s;|&()<>`"']*\{[^{}\s]*,[^{}\s]*\}[^\s;|&()<>`"']*/g) ?? []
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
    // cat < .env, cat 0<.env, cat <>.env, $(< key.pem): the file reaches the program without being its argument.
    secretIn([...command.replace(QUOTED, quoted => quoted.replace(/</g, ' ')).matchAll(/(?<!<)<(?![<(&])>?\s*([^\s<>|;&()]+)/g)].map(([, file = '']) => file), world) ??
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
  // rg x C:\Users, grep -r x /c/Users, gci -Recurse C:\ | sls x: a search from above the home folder.
  const searched =
    [
      ...invocations(command, bin('rg')),
      ...invocations(command, bin('grep|egrep|fgrep')).filter(args => args.some(arg => /^(-[a-zA-Z]*[rR][a-zA-Z]*|--(dereference-)?recursive)$/.test(arg))),
    ]
      .map(args => aboveHome(operands(args), world))
      .find(Boolean) ??
    (readers.length > 0
      ? listers
          .filter(([program, ...args]) => /^(find|fd)$/.test(nameOf(program)) || args.some(arg => /^(-[a-zA-Z]*R[a-zA-Z]*|--recursive)$/.test(arg) || /^(-r|-recurse|\/s)$/i.test(arg)))
          .map(words => aboveHome(words.slice(1), world))
          .find(Boolean)
      : undefined)

  if (searched !== undefined) {
    return searchDeny(searched)
  }

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

  // A message or title is no path: only words without a space are files.
  const sent = SENDERS.flatMap(([program, files]) => invocations(command, program).map(args => secretIn(files(args).filter(word => !/\s/.test(word)), world))).find(Boolean)

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

  // echo "TOKEN=$TOKEN" >> .env writes it where the guard still covers it.
  const intoSecret = secretIn([...command.matchAll(/>>?\s*([^\s|;&<>]+)/g)].map(([, file = '']) => file), world) !== undefined

  if (!intoSecret && (statements.some(printsVar) || [...command.matchAll(BARE_VAR)].some(({ groups }) => groups?.next === undefined || printsInput(groups.next)))) {
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
  allow: allowed
    .split(',')
    .map(glob => glob.trim())
    .filter(Boolean)
    .map(glob => new RegExp(`(^|/)${globSource(norm(glob.replace(HOME_VAR, home)))}$`)),
})

// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
// shortcut: any other MCP tool that runs a command is not read; deny it by name in managed settings (permissions.deny) or add it here.

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
    const command = String((e as { command?: unknown }).command ?? '')
    const world = worldOf(await $.session.cwd(), (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~', await $.env.get('SECRET_READ_ALLOW'))
    // Bash drops a backslash before a letter outside quotes (cat .e\nv is cat .env), so the line is read with and without them;
    // only PowerShell is known not to.
    const bare = command.replace(new RegExp(String.raw`${QUOTED.source}|\\(?=[A-Za-z])`, 'g'), part => (part === '\\' ? '' : part))
    const found = finding(command, world) ?? (e.tool === 'PowerShell' ? undefined : finding(bare, world))

    return found === undefined ? next(e) : { deny: `${$.plugin.name}: ${found}` }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))
}
