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

// shortcut: reads only the text being written, block by innermost braces; a rule split across edits or built from variables is missed, upgrade to checkov on the file if that matters.
const findings = (source: string): string[] => {
  const text = source
    .split('\n')
    .map(line => line.replace(/(^|\s)(#|\/\/).*$/, ''))
    .join('\n')
    .replace(/\$\{[^}]*\}/g, '')
  const found: string[] = []

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
