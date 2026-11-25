import type { Register } from 'claude-code'

const TERRAFORM = /\.(tf|tfvars|hcl|tofu)(\.json)?$/i
// AWS's documented sample keys pass, so docs and tests can quote them: an access key id ending EXAMPLE, and these two secret
// keys exactly (a value that only holds EXAMPLE does not). Built in parts, so no secret scanner takes them for real ones.
const SAMPLE_BODIES = ['wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY', 'je7MtGbClwBF/2Zp9Utk/' + 'h3yCo8nvbEXAMPLEKEY'].join('|')
// A quote, plain or escaped for JSON, a shell or PowerShell: " \" \\\" `"
const QUOTE = String.raw`(?:[\\\x60]{0,8}["'])?`
// The key id with no letter or digit on either side (KEY_AKIA... is one), in upper case only: a lower-case word of its length
// is a word.
const KEY_ID = /(?<![A-Za-z0-9])(?:AKIA|ASIA)(?![A-Z0-9]{9}EXAMPLE)[A-Z0-9]{16}(?![A-Za-z0-9])/
// The secret key by each of its names: the provider's secret_key, the CLI's aws_secret_access_key, the API's SecretAccessKey,
// an action's aws-secret-access-key and Java's aws.secret.key; then the ] of an index (os.environ["..."]), and =, :, the > of
// an XML tag, the comma of a call (props.put("...", ) or the space of aws configure set. The value may sit under a block
// scalar (|, >-) or a heredoc.
const SECRET = new RegExp(
  String.raw`secret[_.-]?(?:access[_.-]?)?key${QUOTE}\]?(?:\s*[=:>,]+|\s)\s*(?:[|>][-+\d]*\s*|<<[-~]?${QUOTE}\w+${QUOTE}\s*)?${QUOTE}(?!(?:${SAMPLE_BODIES})(?![A-Za-z0-9/+]))[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`,
  'i',
)
// The other secrets the rule names: private keys and the API tokens with a fixed shape. This is secret-allow-guard's list of
// formats and more; mods load folder by folder, so each keeps its own. A placeholder made of EXAMPLE passes; a token with
// EXAMPLE added to it does not, since it is still a token once each EXAMPLE is cut to one letter.
// shortcut: no JWTs, bearer values, password= or user:pass@host: in source files those are mostly fixtures and local defaults,
// so they would deny ordinary edits; run gitleaks or trufflehog in CI for those.
const TOKENS = new RegExp(
  [
    String.raw`-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{36,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{60,}`,
    String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
    String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
    // A Slack bot, user or legacy token leads with a digit, so a placeholder made of words passes; a workspace or refresh
    // token may not, so those two are read as before.
    String.raw`\bxox[bps]-\d[A-Za-z0-9-]{9,}`,
    String.raw`\bxox[ar]-[A-Za-z0-9-]{10,}`,
    String.raw`\bxapp-\d-[A-Za-z0-9-]{10,}`,
    String.raw`hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]{20,}`,
    // Anthropic and OpenAI: sk-ant-..., sk-proj-..., and the older bare sk- with one long run (a CSS class sk-fade-in-... has none).
    String.raw`\bsk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{20,}`,
    String.raw`\bsk-[A-Za-z0-9]{32,}`,
    String.raw`\b[sr]k_live_[A-Za-z0-9]{20,}`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])`,
    String.raw`AccountKey=[A-Za-z0-9+/]{86}==`,
    String.raw`\bsbp_[a-f0-9]{40}\b`,
    String.raw`\bsb_secret_[A-Za-z0-9_-]{20,}`,
  ].join('|'),
  'g',
)
const hasToken = (text: string) =>
  (text.match(TOKENS) ?? []).some(found => found.replace(/EXAMPLE/g, 'X').match(TOKENS) !== null)
const secretIn = (text: string) =>
  KEY_ID.test(text) || SECRET.test(text) ? 'an AWS access key' : hasToken(text) ? 'a private key or API token' : undefined
// Any prefix, either slash: C:\repo\.github\workflows\ci.yaml too. A composite action's action.yml is read the same way,
// wherever it sits.
const WORKFLOW = /(^|[\\/])(?:\.github[\\/]workflows[\\/][^\\/]+|action)\.ya?ml$/i
// The tools that hand a command line to a shell, and the parts of one that write a file. 2>&1, >&-, -> and >= are not
// redirections; >&file and =>file are. tee counts only as a command after a pipe, not in a filename like tee.log.
// aws configure set and npm config set write a credentials file with no redirection. So do New-Item -Value, the aliases sc, ac
// and ni where a command starts, dd of=, a call to a write or append method: [IO.File]::WriteAllText(, open().write(,
// fs.writeFileSync(, and a file opened to write (print(..., file=open('f', 'w'))). Set-Item and si count unless the path is
// one of PowerShell's session drives (Env:, Variable:, Function:, Alias:), which are not files.
// shortcut: Set-Item Env:X,file -Value KEY passes; the FileSystem provider does not support Set-Item, so it writes nothing.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
const WRITES =
  /(?<!-)>>?(?!=|&[\d-])|\|\s*(?:sudo\s+)?tee\b|<<|\b(?:Set-Content|Add-Content|Out-File|New-Item)\b|(?:^|[|;&({\n])\s*(?:sc|ac|ni)\s|\bof=|(?:\.|::)(?:write|append)\w*\s*\(|\bconfig(?:ure)?\s+set\b|(?:\bSet-Item|(?:^|[|;&({\n])\s*si)(?!\s+(?:-(?:Literal)?Path[\s:]+)?["']?(?:env|variable|function|alias):)\s|(?:\.open\s*\(|\bopen\s*\([^()]*?,)\s*(?:mode\s*=\s*)?[\\\x60]*["'](?=[rbt]*[wax+])[rwabxt+]{1,4}[\\\x60]*["']/i
// sed -i and perl -pi edit a file in place, and git config writes one. Each is two words anywhere in the command, read apart.
// shortcut: no shell parser here, so grep -i KEY f | sed 1q is denied too; upgrade to shell.ts if that matters.
const WRITE_PAIRS = [
  [/\b(?:sed|perl)\b/i, /\s-[a-z0-9]*i|--in-place/i],
  [/\bgit\b/i, /\bconfig\b/i],
] as const
const writes = (command: string) =>
  WRITES.test(command) || WRITE_PAIRS.some(([tool, flag]) => tool.test(command) && flag.test(command))
const WORLD = /0\.0\.0\.0\/0|::\/0/
const MANAGEMENT_PORTS = [22, 3389]

const port = (body: string, name: string) =>
  Number(new RegExp(`\\b${name}\\s*=\\s*"?(-?\\d+)`).exec(body)?.[1] ?? Number.NaN)

type Block = { start: number; open: number; close: number; kids: Block[] }

// Every { paired with its }, by the place of its {, in one pass: where its head starts (after the line break or brace before
// it) and the blocks directly inside it. A block the text cuts off is left out.
const blocksIn = (text: string) => {
  const closed = new Map<number, Block>()
  const stack: Block[] = []
  let start = 0

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (char === '{') {
      stack.push({ start, open: i, close: -1, kids: [] })
    } else if (char === '}') {
      const block = stack.pop()

      if (block !== undefined) {
        block.close = i
        closed.set(block.open, block)
        stack[stack.length - 1]?.kids.push(block)
      }
    }

    if (char === '{' || char === '}' || char === '\n') {
      start = i + 1
    }
  }

  return closed
}

// A block's text at its own level, each nested block cut down to filler.
const ownText = (text: string, block: Block, filler: string) => {
  let body = ''
  let from = block.open + 1

  for (const kid of block.kids) {
    body += text.slice(from, kid.open) + filler
    from = kid.close + 1
  }

  return body + text.slice(from, block.close)
}

// Each block whose header matches, with its nested blocks and maps emptied so a setting is read at the block's own level; a block the text cuts off is skipped.
const blocksOf = (text: string, header: RegExp) => {
  const closed = blocksIn(text)

  return [...text.matchAll(new RegExp(`${header.source}\\s*\\{`, 'g'))].flatMap(match => {
    const block = closed.get((match.index ?? 0) + match[0].length - 1)

    return block === undefined ? [] : [{ match, body: ownText(text, block, '{}') }]
  })
}

const bodiesOf = (text: string, header: RegExp) => blocksOf(text, header).map(({ body }) => body)

// Each quoted string swapped for what `to` gives; one the text cuts off stays. The optional closing quote keeps the scan
// linear: a failed match would otherwise start again at every quote after it.
const eachString = (text: string, to: (quoted: string) => string) =>
  text.replace(/"(?:\\.|[^"\\])*("?)/g, (quoted: string, end: string) => (end === '' ? quoted : to(quoted)))

// The text without each span from a match of open to the next close; a span never closed stays. Linear, where a regex
// from open to close starts over at every open.
const cut = (text: string, open: RegExp, close: string) => {
  let out = ''
  let from = 0

  for (;;) {
    open.lastIndex = from

    const match = open.exec(text)
    const end = match === null ? -1 : text.indexOf(close, match.index + match[0].length)

    if (match === null || end === -1) {
      return out + text.slice(from)
    }

    out += text.slice(from, match.index)
    from = end + close.length
  }
}

// What the HCL rules and their .tf.json forms report.
const NO_ROTATION = 'creates a KMS key without enable_key_rotation = true'
const NO_WINDOW = 'creates a KMS key without a deletion_window_in_days of 7 to 30'
const NO_FIPS = 'configures a GovCloud provider without use_fips_endpoint = true'
const notSensitive = (kind: string, name: string) => `declares ${kind} "${name}" without sensitive = true`
const literalDefault = (name: string) =>
  `gives variable "${name}" a literal default; pass it in from a secret store or TF_VAR_${name}`
const openPorts = (open: number[]) => `opens port ${open.join(' and ')} to 0.0.0.0/0; restrict the source CIDR`

// The NIST rules for KMS keys, GovCloud providers and secret variables and outputs, read from whole blocks. Each takes the
// text with the braces inside strings gone: a brace in "closing }" is text, not a block.
const kmsFindings = (text: string): string[] => {
  const found: string[] = []

  // Terraform reads a label without its quotes too: resource aws_kms_key logs {.
  for (const body of bodiesOf(text, /resource\s+"?aws_kms_key"?\s+"?[\w-]*"?/)) {
    // Preserve offsets so quoted setting values can be read after locating real assignments.
    const settings = eachString(body, quoted => ' '.repeat(quoted.length))
    const specAt = settings.search(/\b(customer_master_key_spec|key_spec)\s*=/)
    const windowAt = settings.search(/\bdeletion_window_in_days\s*=/)
    const spec = specAt < 0 ? 'SYMMETRIC_DEFAULT' : /^(customer_master_key_spec|key_spec)\s*=\s*"([^"]*)"/.exec(body.slice(specAt))?.[2] ?? 'SYMMETRIC_DEFAULT'
    const window = windowAt < 0 ? null : /^deletion_window_in_days\s*=\s*"?(-?\d+(?![\w.]))?/.exec(body.slice(windowAt))

    // Only symmetric encryption keys rotate.
    if (spec === 'SYMMETRIC_DEFAULT' && !/\benable_key_rotation\s*=\s*true\b/.test(settings)) {
      found.push(NO_ROTATION)
    }

    // A window from a variable passes: its value is not in the text.
    const days = window?.[1] === undefined ? undefined : Number(window[1])

    if (window === null || (days !== undefined && (days < 7 || days > 30))) {
      found.push(NO_WINDOW)
    }
  }

  return found
}

const providerFindings = (text: string): string[] =>
  bodiesOf(text, /provider\s+"?aws"?/).some(
    body => /\bregion\s*=\s*"us-gov-/.test(body) && !/\buse_fips_endpoint\s*=\s*true\b/.test(body),
  )
    ? [NO_FIPS]
    : []

// A name that holds a secret; one ending in what only describes it (secret_arn, password_length, token_ttl, api_key_source)
// does not, nor does a switch (type = bool, default = true).
const isSecretName = (name: string) =>
  /secret|password|passphrase|token|private_key|access_key|api[_-]?key|creds|credentials|[_-](?:pat|pwd)(?:$|[_-])/i.test(name) &&
  !/_(arn|ids?|names?|length|ttl|path|files?|source|types?|required|version|policy|enabled|count|days)$/i.test(name)

const secretNameFindings = (text: string): string[] => {
  const found: string[] = []

  for (const { match, body } of blocksOf(text, /\b(variable|output)\s+"?([\w-]+)"?/)) {
    const [, kind = '', name = ''] = match

    if (!isSecretName(name) || /\btype\s*=\s*bool\b|\bdefault\s*=\s*(?:true|false)\b/.test(body)) {
      continue
    }

    // A description that says "sensitive = true" is not the setting.
    if (!/\bsensitive\s*=\s*true\b/.test(eachString(body, () => '""'))) {
      found.push(notSensitive(kind, name))
    }

    if (kind === 'variable' && /\bdefault\s*=\s*(?:"[^"\n]+"|<<)/.test(body)) {
      found.push(literalDefault(name))
    }
  }

  return found
}

// The values a trust's conditions give a :sub or :aud key, in a jsonencode map, heredoc JSON or aws_iam_policy_document
// condition blocks. A key is read as :sub or :aud alone, since an interpolated host ("${local.gh}:sub") is stripped before
// this runs.
// shortcut: only the first 2000 characters of a list are read, which keeps the scan linear; a longer list's tail is missed.
const conditionValues = (text: string, key: 'sub' | 'aud') =>
  [
    ...[...text.matchAll(new RegExp(`:${key}"\\s*[=:]\\s*(\\[[^\\]]{0,2000}\\]|"[^"]*")`, 'g'))].map(([, value = '']) => value),
    ...bodiesOf(text, /\bcondition/)
      .filter(body => new RegExp(`\\bvariable\\s*=\\s*"[^"]*:${key}"`).test(body))
      .map(body => /\bvalues\s*=\s*(\[[^\]]{0,2000}\])/.exec(body)?.[1] ?? ''),
  ].flatMap(value => [...value.matchAll(/"([^"]*)"/g)].map(([, one = '']) => one))

// An OIDC role trust: GitHub's by its host or its provider's name, any other by a reference to its provider.
const oidcFindings = (text: string, isGithub: boolean): string[] => {
  const found: string[] = []
  const subs = conditionValues(text, 'sub')
  // A wildcard audience checks nothing, so it counts as none.
  const hasAud = /:aud"/.test(text) && !conditionValues(text, 'aud').some(aud => aud.includes('*'))

  if (!isGithub) {
    return [
      ...(/:sub"/.test(text) && !subs.includes('*')
        ? []
        : ['trusts an OIDC provider without a :sub condition, so any identity it issues can assume the role; pin :sub to the workload']),
      ...(hasAud ? [] : ['trusts an OIDC provider without a :aud condition; require the audience the role expects']),
    ]
  }

  // *, repo:*, repo:org/* and repo:org/prefix-*: a star before the repo's own qualifier lets other repositories in.
  const wild = subs.filter(sub => /^\*$|^repo:[^:]*\*/.test(sub))

  if (!/:sub"/.test(text)) {
    found.push('trusts GitHub Actions OIDC without a :sub condition, so any repository can assume it; pin it to repo:<org>/<repo>:...')
  }

  if (wild.length > 0) {
    found.push(`trusts GitHub Actions OIDC for a wildcard repository (${wild.join(', ')}); name the repo in :sub`)
  }

  if (!hasAud) {
    found.push('trusts GitHub Actions OIDC without a :aud condition; require sts.amazonaws.com')
  }

  return found
}

// HCL with or without quoted labels, and .tf.json's "aws_iam_access_key": { key.
const RISKY_RESOURCES = [
  ['aws_iam_access_key', 'creates a static IAM access key (aws_iam_access_key); use an IAM role, or OIDC from CI'],
  ['aws_iam_user_login_profile', 'gives an IAM user a console password (aws_iam_user_login_profile); use IAM Identity Center or a role'],
  ['google_service_account_key', 'creates a long-lived Google service account key (google_service_account_key); use workload identity federation'],
  ['azuread_application_password', 'creates a long-lived Azure application client secret (azuread_application_password); use a federated identity credential'],
  ['azuread_service_principal_password', 'creates a long-lived Azure service principal secret (azuread_service_principal_password); use a federated identity credential'],
] as const

// The value of each Action key: one string, or a list up to its ], so the "*" of a Resource on the same line is not read as
// the action; NotAction and not_actions are other keys. A quote may be escaped, as in a policy string inside .tf.json.
// shortcut: Effect is not read, so a Deny of "*" is flagged too; upgrade to checkov for per-statement reads.
// shortcut: only the first 400 characters of a list are read, which keeps the scan linear; a longer list's tail is missed.
const ACTION_VALUES = /\bactions?\\?"?\s*[=:]\s*(\[[^\]{}]{0,400}|\\?"[^"\\\n]{0,40}\\?")/gi

// A workflow that hands the job a stored key; full-line comments are skipped. A key next to role-to-assume is still a static key,
// while one from an earlier step's, job's or env output is a temporary credential.
const WORKFLOW_RULES = [
  [
    // The env name set in env: (the value may sit under a block scalar, >- or |) or in a run: step (export NAME=, NAME= into
    // $GITHUB_ENV), and aws configure set with a stored key. An output a workflow or action declares under the input's name
    // (the bare key, then value: from anything but secrets) is not a key handed to the job.
    /\baws-(?:access-key-id|secret-access-key)\s*:(?!\s*["']?\$\{\{\s*(?:steps|needs|env)\.)(?![^\S\n]*\n(?:\s+description\s*:[^\n]*\n)?\s+value\s*:(?!\s*["']?\$\{\{\s*secrets[.[]))|\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)\s*[:=]\s*(?:[>|][-+\d]*\s*)?["']?\$\{\{\s*secrets[.[]|\bconfigure\s+set\s+(?:[\w.-]+\.)?aws_(?:access_key_id|secret_access_key)\s+["']?\$\{\{\s*secrets[.[]/,
    'passes a static AWS key to the job; use aws-actions/configure-aws-credentials with role-to-assume and permissions: id-token: write',
  ],
  [
    // The env name, google-github-actions/auth's credentials_json and azure/login's creds, each only when it comes from secrets.
    // The key may be quoted, and the value may sit under a block scalar (>- or |).
    /(?<![\w-])(?:AZURE_CLIENT_SECRET|credentials_json|creds)["']?\s*:\s*(?:[>|][-+]?\s*)?["']?\$\{\{\s*secrets[.[]/,
    'passes a static Azure or Google credential to the job; use workload identity federation (id-token: write, with azure/login client-id, tenant-id and subscription-id, or google-github-actions/auth with workload_identity_provider)',
  ],
] as const

// Each line without its comment: a mark at the line's start or after a space, and not inside a string ("DB #1" is a value).
// A string the line cuts off runs to the line's end.
const comment = (marks: string) => new RegExp(String.raw`("(?:\\.|[^"\\])*"?)|(?:^|\s)(?:${marks})[^]*`, 'g')
const HCL_COMMENT = comment('#|//')
const YAML_COMMENT = comment('#')
const uncomment = (text: string, pattern: RegExp) =>
  text
    .split('\n')
    .map(line => line.replace(pattern, (_all: string, quoted?: string) => quoted ?? ''))
    .join('\n')

const workflowFindings = (source: string): string[] => {
  // shortcut: only "double" quotes are read as strings; a # after a space inside 'single' quotes still cuts the line.
  const text = uncomment(source, YAML_COMMENT)

  return WORKFLOW_RULES.flatMap(([pattern, finding]) => (pattern.test(text) ? [finding] : []))
}

const UNREAD = 'could not be read in full by tf-lint, so some of its rules did not run; review it by hand'

const resourceFindings = (text: string): string[] =>
  RISKY_RESOURCES.flatMap(([type, finding]) =>
    new RegExp(`\\bresource\\s+"?${type}\\b|"${type}"\\s*:\\s*\\{`).test(text) ? [finding] : [],
  )

// The OIDC provider resource names the host too; only a role trust (Federated, AssumeRoleWithWebIdentity) needs the conditions.
// A trust may name the provider only by reference (aws_iam_openid_connect_provider.github.arn).
const trustFindings = (text: string): string[] => {
  const isGithub = /token\.actions\.githubusercontent\.com|openid_connect_provider\.[\w-]*github/i.test(text)

  return /AssumeRoleWithWebIdentity|Federated/.test(text) && (isGithub || /openid_connect_provider\.[\w-]+/.test(text))
    ? oidcFindings(text, isGithub)
    : []
}

// Each wildcard principal needs a condition in its own statement: the block around Principal = "*", or the block around the
// principal map or principals block that holds AWS = "*" or identifiers = ["*"]. Takes the text with the braces inside
// strings gone. A principal whose statement the text cuts off is read as before, against a condition anywhere in the text.
// shortcut: a policy in an escaped JSON string (.tf.json) is not read; upgrade to checkov for those.
const principalFindings = (text: string): string[] => {
  const wild = [...text.matchAll(/\b(Principal|AWS)"?\s*[=:]\s*\[?\s*"\*"|\bidentifiers\s*=\s*\[\s*"\*"/g)]

  if (wild.length === 0) {
    return []
  }

  const conditions = [...text.matchAll(/\bCondition\b|\bcondition\s*\{/g)].map(match => match.index ?? 0)
  const closed = blocksIn(text)
  const parents = new Map([...closed.values()].flatMap(block => block.kids.map(kid => [kid, block] as const)))
  // The innermost { open at each match, in one pass.
  const around = new Map<number, Block | undefined>()
  const stack: number[] = []
  let next = 0

  for (let i = 0; i < text.length && next < wild.length; i += 1) {
    while (next < wild.length && (wild[next]?.index ?? 0) === i) {
      const open = stack[stack.length - 1]
      around.set(i, open === undefined ? undefined : closed.get(open))
      next += 1
    }

    if (text[i] === '{') {
      stack.push(i)
    } else if (text[i] === '}') {
      stack.pop()
    }
  }

  // Whether a condition starts inside the block: the first one after its { comes before its }.
  const hasCondition = (block: Block) => {
    let low = 0
    let high = conditions.length

    while (low < high) {
      const mid = (low + high) >> 1

      if ((conditions[mid] ?? 0) <= block.open) {
        low = mid + 1
      } else {
        high = mid
      }
    }

    return low < conditions.length && (conditions[low] ?? 0) < block.close
  }

  const bare = wild.some(match => {
    const inner = around.get(match.index ?? 0)
    const statement = inner === undefined || match[1] === 'Principal' ? inner : parents.get(inner)

    return statement === undefined ? conditions.length === 0 : !hasCondition(statement)
  })

  return bare
    ? ['grants a policy to Principal "*" with no condition; name the principals or add a Condition (aws:PrincipalOrgID, aws:SourceArn)']
    : []
}

const policyFindings = (text: string): string[] => {
  const found: string[] = []
  const actions = [...text.matchAll(ACTION_VALUES)].map(([, value = '']) => value).join('\n')

  // "*:*" is every action of every service, as "*" is.
  if (/"\*(?::\*)?\\?"/.test(actions)) {
    found.push('grants every action (Action "*") in a policy; name the actions the identity needs')
  }

  if (/"(?:iam|sts):\*\\?"/i.test(actions)) {
    found.push('grants all IAM or STS actions (iam:* or sts:*); name the actions it needs')
  }

  if (/arn:aws(-[a-z-]+)?:/.test(text)) {
    found.push(
      'hardcodes a partition in an ARN; use arn:${data.aws_partition.current.partition}:...',
    )
  }

  return found
}

const portFindings = (text: string): string[] => {
  const found: string[] = []
  // A tags map is not a block: dropped, it leaves the resource body innermost. Other maps may hold rules (locals), so they stay.
  const rest = text.replace(/\b(tags|tags_all)\s*=\s*\{[^{}]*\}/g, '$1 = null')
  // Every block at its own level, the blocks inside it cut out: a rule resource with a lifecycle block is read too.
  const closed = [...blocksIn(rest).values()]
  const parents = new Map(closed.flatMap(block => block.kids.map(kid => [kid, block] as const)))
  const headOf = (block: Block) => rest.slice(block.start, block.open)
  const blocks = closed.map(block => {
    const head = headOf(block)
    const parent = parents.get(block)

    // The content of dynamic "egress" is an egress block: it is read under its parent's head.
    return {
      head: parent !== undefined && /^\s*content\s*$/.test(head) && /^\s*dynamic\s/.test(headOf(parent)) ? headOf(parent) : head,
      body: ownText(rest, block, ''),
    }
  })

  for (const { head, body } of blocks.length > 0 ? blocks : [{ head: '', body: text }]) {
    if (!WORLD.test(body)) {
      continue
    }

    // A rule's direction is its type (the block's keyword, or a resource's type label) or type = "egress", never its name:
    // aws_vpc_security_group_ingress_rule "egress_proxy" is an ingress rule.
    const kind = /^\s*(?:(?:resource|data|dynamic)\s+)?"?([\w-]+)/.exec(head)?.[1] ?? ''
    // A network ACL rule says egress = true; in a description those words are text.
    const isEgress =
      /egress/.test(kind) ||
      /type\s*=\s*"egress"/.test(body) ||
      /(?<![\w-])egress\s*=\s*true\b/.test(eachString(body, () => '""'))
    const from = port(body, 'from_port')
    const to = port(body, 'to_port')
    // Protocol -1 is every port, whatever from_port and to_port say.
    const isEveryPort = /protocol\s*=\s*"?(-1|all)\b/.test(body)
    const open = MANAGEMENT_PORTS.filter(one => isEveryPort || (from <= one && one <= to))

    if (!isEgress && open.length > 0) {
      found.push(openPorts(open))
    }
  }

  return found
}

type Body = Record<string, unknown>

// Terraform's JSON syntax: a block is one object or a list of them, at any level.
const each = (value: unknown): Body[] =>
  Array.isArray(value) ? value.flatMap(each) : typeof value === 'object' && value !== null ? [value as Body] : []
const number = (value: unknown) =>
  typeof value === 'number' ? value : typeof value === 'string' && /^\s*-?\d+\s*$/.test(value) ? Number(value) : undefined
const isTrue = (value: unknown) => value === true || value === 'true'

// The KMS, provider, port and secret-name rules for .tf.json, read from the parsed document. Text that is not JSON (an HCL
// file, an Edit's fragment) gives none; the text rules still run on it.
// shortcut: the trust and wildcard-principal rules are not read here; a policy in .tf.json is an escaped string.
const jsonFindings = (source: string): string[] => {
  if (!/^\s*[[{]/.test(source)) {
    return []
  }

  let doc: unknown

  try {
    doc = JSON.parse(source)
  } catch {
    return []
  }

  const roots = each(doc)
  const found: string[] = []
  // resource.<type>.<name> and provider.<name>, each body once.
  const resources = (type: string) => roots.flatMap(root => each(root.resource)).flatMap(group => each(group[type])).flatMap(named => Object.values(named).flatMap(each))
  const labelled = (key: string) => roots.flatMap(root => each(root[key])).flatMap(group => Object.entries(group).flatMap(([name, body]) => each(body).map(one => [name, one] as const)))

  for (const key of resources('aws_kms_key')) {
    const spec = key.customer_master_key_spec ?? key.key_spec
    const days = number(key.deletion_window_in_days)

    // Only symmetric encryption keys rotate; a spec from an expression is read as symmetric, as in HCL.
    if ((typeof spec !== 'string' || spec === 'SYMMETRIC_DEFAULT' || spec.includes('${')) && !isTrue(key.enable_key_rotation)) {
      found.push(NO_ROTATION)
    }

    if (key.deletion_window_in_days == null || (days !== undefined && (days < 7 || days > 30))) {
      found.push(NO_WINDOW)
    }
  }

  if (labelled('provider').some(([name, body]) => name === 'aws' && /^us-gov-/.test(String(body.region ?? '')) && !isTrue(body.use_fips_endpoint))) {
    found.push(NO_FIPS)
  }

  for (const [kind, [name, body]] of ['variable', 'output'].flatMap(kind => labelled(kind).map(one => [kind, one] as const))) {
    if (!isSecretName(name) || body.type === 'bool' || typeof body.default === 'boolean') {
      continue
    }

    if (!isTrue(body.sensitive)) {
      found.push(notSensitive(kind, name))
    }

    if (kind === 'variable' && typeof body.default === 'string' && body.default !== '') {
      found.push(literalDefault(name))
    }
  }

  // Every object, by the keys that lead to it: a rule's direction is its block's key or its resource's type, never its name.
  const visit = (value: unknown, keys: string[]): void => {
    for (const body of each(value)) {
      const own = Object.values(body).flat().filter(one => typeof one !== 'object' || one === null)
      const last = keys.length === 3 && keys[0] === 'resource' ? keys[1] : keys[keys.length - 1] === 'content' && keys[keys.length - 3] === 'dynamic' ? keys[keys.length - 2] : keys[keys.length - 1]

      if (own.some(one => typeof one === 'string' && WORLD.test(one)) && !/egress/.test(last ?? '') && body.type !== 'egress' && !isTrue(body.egress)) {
        const from = number(body.from_port) ?? Number.NaN
        const to = number(body.to_port) ?? Number.NaN
        const isEveryPort = /^(-1|all)$/.test(String(body.protocol ?? body.ip_protocol ?? ''))
        const open = MANAGEMENT_PORTS.filter(one => isEveryPort || (from <= one && one <= to))

        if (open.length > 0) {
          found.push(openPorts(open))
        }
      }

      for (const [key, inner] of Object.entries(body)) {
        visit(inner, [...keys, key])
      }
    }
  }

  visit(doc, [])

  return found
}

// shortcut: reads only the text being written, block by block (after an Edit, the whole file too); a rule built from
// variables is missed, upgrade to checkov on the file if that matters.
const findings = (source: string): string[] => {
  // A block comment, only when it starts its line: "bucket/*" and "cron(0 */2 * * ? *)" in strings are not one.
  const text = cut(uncomment(cut(source, /^[^\S\n]*\/\*/gm, '*/'), HCL_COMMENT), /\$\{/g, '}')
  const bare = eachString(text, quoted => quoted.replace(/[{}]/g, ''))
  const found: string[] = []
  let hasFailed = false

  // A rule that throws loses only its own findings, and the reader is told the read was not whole.
  for (const rule of [
    () => kmsFindings(bare),
    () => providerFindings(bare),
    () => secretNameFindings(bare),
    () => resourceFindings(text),
    () => trustFindings(text),
    () => principalFindings(bare),
    () => policyFindings(text),
    () => portFindings(text),
    () => jsonFindings(source),
  ]) {
    try {
      for (const one of rule()) {
        found.push(one)
      }
    } catch {
      hasFailed = true
    }
  }

  return hasFailed ? [UNREAD, ...found] : found
}

const MOST = 20

// The findings for one write, each once and the first few only; a linter that throws says so, where a replayed call would
// drop every warning.
const lint = (file: string, texts: string[]): string[] => {
  try {
    const found = [
      ...new Set(texts.flatMap(text => (TERRAFORM.test(file) ? findings(text) : WORKFLOW.test(file) ? workflowFindings(text) : []))),
    ]

    return found.length > MOST ? [...found.slice(0, MOST), `has ${found.length - MOST} more finding(s) not listed`] : found
  } catch {
    return [UNREAD]
  }
}

export const register: Register = on => {
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const text = e.tool === 'Edit' ? e.new_string : e.tool === 'Write' ? e.content : e.new_source
    const file = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    const secret = secretIn(text)

    if (secret !== undefined) {
      return {
        deny: `${$.plugin.name}: this would write ${secret} into ${file}. Reference a secret store or the environment.`,
      }
    }

    const ran = await next(e)
    // An Edit's text may hold only part of a rule (a trust's :sub, a KMS key's window), so the file it lands in is read
    // whole too; a file that cannot be read leaves the text alone, as before.
    const whole =
      e.tool === 'Edit' && ran.deny === undefined && (TERRAFORM.test(file) || WORKFLOW.test(file))
        ? await $.fs.read(file).then(String, () => undefined)
        : undefined
    const found = lint(file, whole === undefined ? [text] : [text, whole])

    if (ran.deny !== undefined || found.length === 0) {
      return ran
    }

    $.ui.toast(`${$.plugin.name}: ${found.length} finding(s) in ${file}`)

    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        `${$.plugin.name}: the text just written to ${file}${whole === undefined ? '' : ', or the file around it,'} ${found.join('; and ')}. Fix it before finishing.`,
      ],
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )

  // A key echoed into a file from a shell, or handed to an MCP server, leaks as surely as one written by Edit.
  on('tool.call', ($, e, next) => {
    const { tool, ...args } = e as unknown as { tool: string; [key: string]: unknown }

    if (SHELL_TOOLS.includes(tool)) {
      const command = String(args.command ?? '')
      const secret = writes(command) ? secretIn(command) : undefined

      return secret === undefined
        ? next(e)
        : { deny: `${$.plugin.name}: this command would write ${secret} into a file. Reference a secret store or the environment.` }
    }

    if (!tool.startsWith('mcp__')) {
      return next(e)
    }

    // JSON escapes a nested string's quotes, which hides secret_key = "..." from SECRET, so each string is read on its own too,
    // and one that is itself JSON (a body built with JSON.stringify, to five levels) is decoded and read the same way.
    const leaves: string[] = []
    const collect = (value: unknown, depth: number): void => {
      if (typeof value === 'string') {
        leaves.push(value)

        if (depth < 5 && /^\s*[[{"]/.test(value)) {
          let inner: unknown

          try {
            inner = JSON.parse(value)
          } catch {
            return
          }

          leaves.push(JSON.stringify(inner))
          collect(inner, depth + 1)
        }
      } else if (typeof value === 'object' && value !== null) {
        Object.values(value).forEach(inner => collect(inner, depth))
      }
    }

    collect(args, 0)

    const json = JSON.stringify(args)
    const secret = [json, ...leaves].map(secretIn).find(found => found !== undefined)

    return secret === undefined
      ? next(e)
      : { deny: `${$.plugin.name}: this would send ${secret} to ${tool}. Reference a secret store or the environment.` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
