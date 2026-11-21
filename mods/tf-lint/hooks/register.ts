import type { Register } from 'claude-code'

const TERRAFORM = /\.(tf|tfvars|hcl|tofu)(\.json)?$/i
// AWS's documented sample keys (…EXAMPLE) pass, so docs and tests can quote them. The secret key by each of its names: the
// provider's secret_key, the CLI's aws_secret_access_key, the API's SecretAccessKey.
const SECRET =
  /\b(?:AKIA|ASIA)(?![A-Z0-9]{9}EXAMPLE)[A-Z0-9]{16}\b|secret_?(?:access_?)?key["']?\s*[=:]\s*["']?(?![^"'\s]*EXAMPLE)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i
// The other secrets the rule names: private keys and the API tokens with a fixed shape. This is secret-allow-guard's list of
// formats and more; mods load folder by folder, so each keeps its own. A value holding EXAMPLE passes, as AWS's samples do.
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
const hasToken = (text: string) => (text.match(TOKENS) ?? []).some(found => !found.includes('EXAMPLE'))
const secretIn = (text: string) =>
  SECRET.test(text) ? 'an AWS access key' : hasToken(text) ? 'a private key or API token' : undefined
// Any prefix, either slash: C:\repo\.github\workflows\ci.yaml too.
const WORKFLOW = /(^|[\\/])\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/i
// The tools that hand a command line to a shell, and the parts of one that write a file. 2>&1, >&-, -> and >= are not
// redirections; >&file and =>file are. tee counts only as a command after a pipe, not in a filename like tee.log.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'mcp__terminal__run_in_terminal']
const WRITES = /(?<!-)>>?(?!=|&[\d-])|\|\s*(?:sudo\s+)?tee\b|<<|\b(?:Set-Content|Add-Content|Out-File)\b/i
const WORLD = /0\.0\.0\.0\/0|::\/0/
const MANAGEMENT_PORTS = [22, 3389]

const port = (body: string, name: string) =>
  Number(new RegExp(`\\b${name}\\s*=\\s*"?(-?\\d+)`).exec(body)?.[1] ?? Number.NaN)

// The body of each block whose header matches, with its nested blocks and maps emptied so a setting is read at the block's own level; a block the text cuts off is skipped.
const bodiesOf = (text: string, header: RegExp) =>
  [...text.matchAll(new RegExp(`${header.source}\\s*\\{`, 'g'))].flatMap(match => {
    const start = (match.index ?? 0) + match[0].length
    let depth = 1

    for (let i = start; i < text.length; i += 1) {
      depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0

      if (depth === 0) {
        let body = text.slice(start, i)

        while (/\{[^{}]*[^{}\s][^{}]*\}/.test(body)) {
          body = body.replace(/\{[^{}]*\}/g, '{}')
        }

        return [body]
      }
    }

    return []
  })

// The NIST rules for KMS keys, GovCloud providers and secret variables and outputs, read from whole blocks.
const blockFindings = (source: string): string[] => {
  // A brace inside a string ("closing }") is text, not a block.
  const text = source.replace(/"(?:\\.|[^"\\])*"/g, quoted => quoted.replace(/[{}]/g, ''))
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

  for (const body of bodiesOf(text, /provider\s+"?aws"?/)) {
    if (/\bregion\s*=\s*"us-gov-/.test(body) && !/\buse_fips_endpoint\s*=\s*true\b/.test(body)) {
      found.push('configures a GovCloud provider without use_fips_endpoint = true')
    }
  }

  // A name that holds a secret; one ending in what only describes it (secret_arn, password_length, token_ttl) does not.
  for (const [, kind = '', name = ''] of text.matchAll(/\b(variable|output)\s+"?([\w-]+)"?\s*\{/g)) {
    if (
      !/secret|password|token|private_key|access_key/i.test(name) ||
      /_(arn|ids?|names?|length|ttl|path|version|policy|enabled|count|days)$/i.test(name)
    ) {
      continue
    }

    for (const body of bodiesOf(text, new RegExp(`\\b${kind}\\s+"?${name}"?`))) {
      // A description that says "sensitive = true" is not the setting.
      if (!/\bsensitive\s*=\s*true\b/.test(body.replace(/"(?:\\.|[^"\\])*"/g, '""'))) {
        found.push(`declares ${kind} "${name}" without sensitive = true`)
      }

      if (kind === 'variable' && /\bdefault\s*=\s*(?:"[^"\n]+"|<<)/.test(body)) {
        found.push(`gives variable "${name}" a literal default; pass it in from a secret store or TF_VAR_${name}`)
      }
    }
  }

  return found
}

// GitHub's OIDC trust, as a jsonencode map, heredoc JSON or aws_iam_policy_document condition blocks. A key is read as :sub or
// :aud alone, since an interpolated host ("${local.gh}:sub") is stripped before this runs.
const oidcFindings = (text: string): string[] => {
  const found: string[] = []
  const values = [
    ...[...text.matchAll(/:sub"\s*[=:]\s*(\[[^\]]*\]|"[^"]*")/g)].map(([, value = '']) => value),
    ...bodiesOf(text, /\bcondition/)
      .filter(body => /\bvariable\s*=\s*"[^"]*:sub"/.test(body))
      .map(body => /\bvalues\s*=\s*(\[[^\]]*\])/.exec(body)?.[1] ?? ''),
  ]
  // *, repo:*, repo:org/* and repo:org/prefix-*: a star before the repo's own qualifier lets other repositories in.
  const wild = values
    .flatMap(value => [...value.matchAll(/"([^"]*)"/g)].map(([, sub = '']) => sub))
    .filter(sub => /^\*$|^repo:[^:]*\*/.test(sub))

  if (!/:sub"/.test(text)) {
    found.push('trusts GitHub Actions OIDC without a :sub condition, so any repository can assume it; pin it to repo:<org>/<repo>:...')
  }

  if (wild.length > 0) {
    found.push(`trusts GitHub Actions OIDC for a wildcard repository (${wild.join(', ')}); name the repo in :sub`)
  }

  if (!/:aud"/.test(text)) {
    found.push('trusts GitHub Actions OIDC without a :aud condition; require sts.amazonaws.com')
  }

  return found
}

// HCL with or without quoted labels, and .tf.json's "aws_iam_access_key": { key.
const RISKY_RESOURCES = [
  ['aws_iam_access_key', 'creates a static IAM access key (aws_iam_access_key); use an IAM role, or OIDC from CI'],
  ['aws_iam_user_login_profile', 'gives an IAM user a console password (aws_iam_user_login_profile); use IAM Identity Center or a role'],
] as const

// A workflow that hands the job a stored key; full-line comments are skipped. A key next to role-to-assume is still a static key,
// while one from an earlier step's, job's or env output is a temporary credential.
const workflowFindings = (source: string): string[] =>
  /\baws-(?:access-key-id|secret-access-key)\s*:(?!\s*["']?\$\{\{\s*(?:steps|needs|env)\.)|\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)\s*:\s*["']?\$\{\{\s*secrets[.[]/.test(
    source.replace(/^\s*#.*$/gm, ''),
  )
    ? ['passes a static AWS key to the job; use aws-actions/configure-aws-credentials with role-to-assume and permissions: id-token: write']
    : []

// shortcut: reads only the text being written, block by block; a rule split across edits or built from variables is missed, upgrade to checkov on the file if that matters.
const findings = (source: string): string[] => {
  const text = source
    // A block comment, only when it starts its line: "bucket/*" and "cron(0 */2 * * ? *)" in strings are not one.
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .split('\n')
    .map(line => line.replace(/(^|\s)(#|\/\/).*$/, ''))
    .join('\n')
    .replace(/\$\{[^}]*\}/g, '')
  const found = blockFindings(text)

  for (const [type, finding] of RISKY_RESOURCES) {
    if (new RegExp(`\\bresource\\s+"?${type}\\b|"${type}"\\s*:\\s*\\{`).test(text)) {
      found.push(finding)
    }
  }

  // The OIDC provider resource names the host too; only a role trust (Federated, AssumeRoleWithWebIdentity) needs the conditions.
  // A trust may name the provider only by reference (aws_iam_openid_connect_provider.github.arn).
  if (
    /token\.actions\.githubusercontent\.com|openid_connect_provider\.[\w-]*github/i.test(text) &&
    /AssumeRoleWithWebIdentity|Federated/.test(text)
  ) {
    found.push(...oidcFindings(text))
  }

  // shortcut: a condition anywhere in the text clears every wildcard principal in it; upgrade to checkov for per-statement reads.
  if (
    /\b(?:Principal|AWS)"?\s*[=:]\s*\[?\s*"\*"|\bidentifiers\s*=\s*\[\s*"\*"/.test(text) &&
    !/\bCondition\b|\bcondition\s*\{/.test(text)
  ) {
    found.push('grants a policy to Principal "*" with no condition; name the principals or add a Condition (aws:PrincipalOrgID, aws:SourceArn)')
  }

  if (/arn:aws(-[a-z-]+)?:/.test(text)) {
    found.push(
      'hardcodes a partition in an ARN; use arn:${data.aws_partition.current.partition}:...',
    )
  }

  // A tags map is not a block: dropped, it leaves the resource body innermost. Other maps may hold rules (locals), so they stay.
  const BLOCK = /([^\n{}]*)\{([^{}]*)\}/g
  const blocks: { head: string; body: string }[] = []
  let rest = text.replace(/\b(tags|tags_all)\s*=\s*\{[^{}]*\}/g, '$1 = null')

  // Innermost blocks, then the ones that held them with those emptied: a rule resource with a lifecycle block is read too.
  for (let inner = [...rest.matchAll(BLOCK)]; inner.length > 0; inner = [...rest.matchAll(BLOCK)]) {
    blocks.push(...inner.map(([, head = '', body = '']) => ({ head, body })))
    rest = rest.replace(BLOCK, '$1')
  }

  for (const { head, body } of blocks.length > 0 ? blocks : [{ head: '', body: text }]) {
    const isEgress = /egress/.test(head) || /type\s*=\s*"egress"/.test(body)
    const from = port(body, 'from_port')
    const to = port(body, 'to_port')
    // Protocol -1 is every port, whatever from_port and to_port say.
    const isEveryPort = /protocol\s*=\s*"?(-1|all)\b/.test(body)
    const open = MANAGEMENT_PORTS.filter(one => isEveryPort || (from <= one && one <= to))

    if (!isEgress && WORLD.test(body) && open.length > 0) {
      found.push(`opens port ${open.join(' and ')} to 0.0.0.0/0; restrict the source CIDR`)
    }
  }

  return found
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
    const found = TERRAFORM.test(file) ? findings(text) : WORKFLOW.test(file) ? workflowFindings(text) : []

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

    // JSON escapes a nested string's quotes, which hides secret_key = "..." from SECRET, so each string is read on its own too.
    const leaves: string[] = []
    const json = JSON.stringify(args, (_, value: unknown) => {
      if (typeof value === 'string') {
        leaves.push(value)
      }

      return value
    })
    const secret = [json, ...leaves].map(secretIn).find(found => found !== undefined)

    return secret === undefined
      ? next(e)
      : { deny: `${$.plugin.name}: this would send ${secret} to ${tool}. Reference a secret store or the environment.` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
