import type { Register } from 'claude-code'

const TERRAFORM = /\.(tf|tfvars|hcl)(\.json)?$/i
// AWS's documented sample keys (…EXAMPLE) pass, so docs and tests can quote them.
const SECRET =
  /\b(?:AKIA|ASIA)(?![A-Z0-9]{9}EXAMPLE)[A-Z0-9]{16}\b|secret_access_key["']?\s*[=:]\s*["']?(?![^"'\s]*EXAMPLE)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/i
// The other secrets the rule names: private keys and API tokens (GitHub, Slack).
const TOKEN =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}|\bxox[abpr]-[A-Za-z0-9-]{10,}/
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

// The NIST rules for KMS keys and GovCloud providers, read from whole resource and provider blocks.
const keyAndProviderFindings = (text: string): string[] => {
  const found: string[] = []

  for (const body of bodiesOf(text, /resource\s+"aws_kms_key"\s+"[^"]*"/)) {
    const spec = /\b(customer_master_key_spec|key_spec)\s*=\s*"([^"]*)"/.exec(body)?.[2] ?? 'SYMMETRIC_DEFAULT'
    const window = /\bdeletion_window_in_days\s*=\s*(\S+)/.exec(body)?.[1]

    // Only symmetric encryption keys rotate.
    if (spec === 'SYMMETRIC_DEFAULT' && !/\benable_key_rotation\s*=\s*true\b/.test(body)) {
      found.push('creates a KMS key without enable_key_rotation = true')
    }

    // A window from a variable passes: its value is not in the text.
    if (window === undefined || (/^\d+$/.test(window) && (Number(window) < 7 || Number(window) > 30))) {
      found.push('creates a KMS key without a deletion_window_in_days of 7 to 30')
    }
  }

  for (const body of bodiesOf(text, /provider\s+"aws"/)) {
    if (/\bregion\s*=\s*"us-gov-/.test(body) && !/\buse_fips_endpoint\s*=\s*true\b/.test(body)) {
      found.push('configures a GovCloud provider without use_fips_endpoint = true')
    }
  }

  return found
}

// shortcut: reads only the text being written, block by innermost braces; a rule split across edits or built from variables is missed, upgrade to checkov on the file if that matters.
const findings = (source: string): string[] => {
  const text = source
    .split('\n')
    .map(line => line.replace(/(^|\s)(#|\/\/).*$/, ''))
    .join('\n')
    .replace(/\$\{[^}]*\}/g, '')
  const found = keyAndProviderFindings(text)

  if (/arn:aws(-us-gov|-cn)?:/.test(text)) {
    found.push(
      'hardcodes a partition in an ARN; use arn:${data.aws_partition.current.partition}:...',
    )
  }

  const blocks = [...text.matchAll(/([^\n{}]*)\{([^{}]*)\}/g)].map(
    ([, head = '', body = '']) => ({ head, body }),
  )

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
    const secret = SECRET.test(text) ? 'an AWS access key' : TOKEN.test(text) ? 'a private key or API token' : undefined

    if (secret !== undefined) {
      return {
        deny: `${$.plugin.name}: this would write ${secret} into ${file}. Reference a secret store or the environment.`,
      }
    }

    const ran = await next(e)
    const found = TERRAFORM.test(file) ? findings(text) : []

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
}
