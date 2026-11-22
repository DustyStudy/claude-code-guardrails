import type { Register } from 'claude-code'

const TERRAFORM = /\.(tf|tfvars|hcl|tofu)(\.json)?$/i
// AWS's documented sample keys pass, so docs and tests can quote them: an access key id ending EXAMPLE, and these two secret
// keys exactly (a value that only holds EXAMPLE does not). Built in parts, so no secret scanner takes them for real ones.
const SAMPLE_SECRETS = ['wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY', 'je7MtGbClwBF/2Zp9Utk/' + 'h3yCo8nvbEXAMPLEKEY'].join('|')
// A quote, plain or escaped for JSON, a shell or PowerShell: " \" \\\" `"
const QUOTE = String.raw`(?:[\\\x60]{0,8}["'])?`
// The key id with no letter or digit on either side (KEY_AKIA... is one). The secret key by each of its names: the provider's
// secret_key, the CLI's aws_secret_access_key, the API's SecretAccessKey, an action's aws-secret-access-key and Java's
// aws.secret.key; then =, :, the > of an XML tag or the space of aws configure set.
const SECRET = new RegExp(
  String.raw`(?<![A-Z0-9])(?:AKIA|ASIA)(?![A-Z0-9]{9}EXAMPLE)[A-Z0-9]{16}(?![A-Z0-9])|` +
    String.raw`secret[_.-]?(?:access[_.-]?)?key${QUOTE}(?:\s*[=:>]+|\s)\s*${QUOTE}(?!(?:${SAMPLE_SECRETS})(?![A-Za-z0-9/+]))[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])`,
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
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
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
  SECRET.test(text) ? 'an AWS access key' : hasToken(text) ? 'a private key or API token' : undefined
// Any prefix, either slash: C:\repo\.github\workflows\ci.yaml too. A composite action under .github/actions is read the same way.
const WORKFLOW = /(^|[\\/])\.github[\\/](?:workflows[\\/][^\\/]+|actions[\\/](?:[^\\/]+[\\/])*action)\.ya?ml$/i
// The tools that hand a command line to a shell, and the parts of one that write a file. 2>&1, >&-, -> and >= are not
// redirections; >&file and =>file are. tee counts only as a command after a pipe, not in a filename like tee.log.
// aws configure set and npm config set write a credentials file with no redirection.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
const WRITES = /(?<!-)>>?(?!=|&[\d-])|\|\s*(?:sudo\s+)?tee\b|<<|\b(?:Set-Content|Add-Content|Out-File)\b|\bconfig(?:ure)?\s+set\b/i
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

// The NIST rules for KMS keys, GovCloud providers and secret variables and outputs, read from whole blocks. Each takes the
// text with the braces inside strings gone: a brace in "closing }" is text, not a block.
const kmsFindings = (text: string): string[] => {
  const found: string[] = []

  // Terraform reads a label without its quotes too: resource aws_kms_key logs {.
  for (const body of bodiesOf(text, /resource\s+"?aws_kms_key"?\s+"?[\w-]*"?/)) {
    const spec = /\b(customer_master_key_spec|key_spec)\s*=\s*"([^"]*)"/.exec(body)?.[2] ?? 'SYMMETRIC_DEFAULT'
    const window = /\bdeletion_window_in_days\s*=\s*"?(-?\d+(?![\w.]))?/.exec(body)

    // Only symmetric encryption keys rotate.
    if (spec === 'SYMMETRIC_DEFAULT' && !/\benable_key_rotation\s*=\s*true\b/.test(body)) {
      found.push('creates a KMS key without enable_key_rotation = true')
    }

    // A window from a variable passes: its value is not in the text.
    const days = window?.[1] === undefined ? undefined : Number(window[1])

    if (window === null || (days !== undefined && (days < 7 || days > 30))) {
      found.push('creates a KMS key without a deletion_window_in_days of 7 to 30')
    }
  }

  return found
}

const providerFindings = (text: string): string[] =>
  bodiesOf(text, /provider\s+"?aws"?/).some(
    body => /\bregion\s*=\s*"us-gov-/.test(body) && !/\buse_fips_endpoint\s*=\s*true\b/.test(body),
  )
    ? ['configures a GovCloud provider without use_fips_endpoint = true']
    : []

// A name that holds a secret; one ending in what only describes it (secret_arn, password_length, token_ttl, api_key_source)
// does not, nor does a switch (type = bool, default = true).
const secretNameFindings = (text: string): string[] => {
  const found: string[] = []

  for (const { match, body } of blocksOf(text, /\b(variable|output)\s+"?([\w-]+)"?/)) {
    const [, kind = '', name = ''] = match

    if (
      !/secret|password|token|private_key|access_key|api[_-]?key/i.test(name) ||
      /_(arn|ids?|names?|length|ttl|path|files?|source|types?|required|version|policy|enabled|count|days)$/i.test(name) ||
      /\btype\s*=\s*bool\b|\bdefault\s*=\s*(?:true|false)\b/.test(body)
    ) {
      continue
    }

    // A description that says "sensitive = true" is not the setting.
    if (!/\bsensitive\s*=\s*true\b/.test(eachString(body, () => '""'))) {
      found.push(`declares ${kind} "${name}" without sensitive = true`)
    }

    if (kind === 'variable' && /\bdefault\s*=\s*(?:"[^"\n]+"|<<)/.test(body)) {
      found.push(`gives variable "${name}" a literal default; pass it in from a secret store or TF_VAR_${name}`)
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

const workflowFindings = (source: string): string[] => {
  // Comments go, full-line and trailing: a # at the line's start or after a space.
  const text = source.replace(/(^|\s)#.*$/gm, '$1')

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

const policyFindings = (text: string): string[] => {
  const found: string[] = []

  // shortcut: a condition anywhere in the text clears every wildcard principal in it; upgrade to checkov for per-statement reads.
  if (
    /\b(?:Principal|AWS)"?\s*[=:]\s*\[?\s*"\*"|\bidentifiers\s*=\s*\[\s*"\*"/.test(text) &&
    !/\bCondition\b|\bcondition\s*\{/.test(text)
  ) {
    found.push('grants a policy to Principal "*" with no condition; name the principals or add a Condition (aws:PrincipalOrgID, aws:SourceArn)')
  }

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
  const blocks = [...blocksIn(rest).values()].map(block => ({
    head: rest.slice(block.start, block.open),
    body: ownText(rest, block, ''),
  }))

  for (const { head, body } of blocks.length > 0 ? blocks : [{ head: '', body: text }]) {
    if (!WORLD.test(body)) {
      continue
    }

    // A rule's direction is its type (the block's keyword, or a resource's type label) or type = "egress", never its name:
    // aws_vpc_security_group_ingress_rule "egress_proxy" is an ingress rule.
    const kind = /^\s*(?:(?:resource|data|dynamic)\s+)?"?([\w-]+)/.exec(head)?.[1] ?? ''
    const isEgress = /egress/.test(kind) || /type\s*=\s*"egress"/.test(body)
    const from = port(body, 'from_port')
    const to = port(body, 'to_port')
    // Protocol -1 is every port, whatever from_port and to_port say.
    const isEveryPort = /protocol\s*=\s*"?(-1|all)\b/.test(body)
    const open = MANAGEMENT_PORTS.filter(one => isEveryPort || (from <= one && one <= to))

    if (!isEgress && open.length > 0) {
      found.push(`opens port ${open.join(' and ')} to 0.0.0.0/0; restrict the source CIDR`)
    }
  }

  return found
}

// shortcut: reads only the text being written, block by block; a rule split across edits or built from variables is missed, upgrade to checkov on the file if that matters.
const findings = (source: string): string[] => {
  // A block comment, only when it starts its line: "bucket/*" and "cron(0 */2 * * ? *)" in strings are not one.
  const text = cut(
    cut(source, /^[^\S\n]*\/\*/gm, '*/')
      .split('\n')
      .map(line => line.replace(/(^|\s)(#|\/\/).*$/, ''))
      .join('\n'),
    /\$\{/g,
    '}',
  )
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
    () => policyFindings(text),
    () => portFindings(text),
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
const lint = (file: string, text: string): string[] => {
  try {
    const found = [...new Set(TERRAFORM.test(file) ? findings(text) : WORKFLOW.test(file) ? workflowFindings(text) : [])]

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
    const found = lint(file, text)

    if (ran.deny !== undefined || found.length === 0) {
      return ran
    }

    $.ui.toast(`${$.plugin.name}: ${found.length} finding(s) in ${file}`)

    return {
      ...ran,
      context: [
        ...(ran.context ?? []),
        `${$.plugin.name}: the text just written to ${file} ${found.join('; and ')}. Fix it before finishing.`,
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
      const secret = WRITES.test(command) ? secretIn(command) : undefined

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
