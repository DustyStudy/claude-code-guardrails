import type { EngineInterface, Register } from 'claude-code'

const TOOL = 'mcp__tf-plan-summary__plan_summary'
// Changes a reviewer must see by name: identity, keys, network exposure, bucket access, the organization.
const SENSITIVE =
  /^aws_(iam_|kms_|security_group|vpc_security_group_|network_acl|s3_bucket_policy|s3_bucket_public_access_block|s3_bucket_acl|s3_account_public_access_block|organizations_|ram_|lambda_permission|secretsmanager_|cloudtrail|config_)/
// Past this many ordinary changes, the rest are counted, not listed.
const MAX_OTHER = 25
const MAX_KEYS = 6
const ABSOLUTE = /^([a-zA-Z]:[\\/]|[\\/])/

type Change = {
  address: string
  type: string
  change: {
    actions: string[]
    before?: Record<string, unknown> | null
    after?: Record<string, unknown> | null
    after_unknown?: Record<string, unknown>
    replace_paths?: unknown[][]
    importing?: unknown
  }
}

type Plan = {
  resource_changes?: Change[]
  resource_drift?: Change[]
  output_changes?: Record<string, { actions: string[] }>
}

// Terraform's own pairs: delete and create in either order is a replace; forget leaves the object but drops it from state.
const actionOf = ({ change }: Change) =>
  change.actions.includes('delete') && change.actions.includes('create')
    ? 'replace'
    : change.actions.join('+') === 'no-op' && change.importing
      ? 'import'
      : change.actions.join('+')

// The names of the top-level attributes that change, never their values: plan JSON holds sensitive values in plain text.
const changedKeys = ({ change }: Change): string[] => {
  const before = change.before ?? {}
  const after = change.after ?? {}
  const unknown = change.after_unknown ?? {}

  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    key =>
      JSON.stringify(before[key]) !== JSON.stringify(after[key]) ||
      JSON.stringify(unknown[key] ?? false).includes('true'),
  )
}

const lineOf = (one: Change) => {
  const action = actionOf(one)
  const forced = [...new Set((one.change.replace_paths ?? []).map(path => String(path[0])))]
  const keys = action === 'update' ? changedKeys(one) : []
  const detail =
    forced.length > 0
      ? ` (forced by: ${forced.join(', ')})`
      : keys.length > 0
        ? ` (${keys.slice(0, MAX_KEYS).join(', ')}${keys.length > MAX_KEYS ? `, +${keys.length - MAX_KEYS}` : ''})`
        : ''

  return `- ${one.address}: ${action}${detail}`
}

/** The plan in a few lines: counts, every destroy and replace, and security-sensitive changes by name. */
export const summarize = (plan: Plan, file: string): string => {
  const changes = (plan.resource_changes ?? []).filter(one => !['no-op', 'read'].includes(actionOf(one)))
  const count = (action: string) => changes.filter(one => actionOf(one) === action).length
  const forgets = changes.filter(one => one.change.actions.includes('forget')).length
  // An import can ride on a create or update too: counted by its own mark, never by its id.
  const imports = changes.filter(one => one.change.importing).length
  const outputs = Object.entries(plan.output_changes ?? {})
    .filter(([, change]) => !change.actions.includes('no-op'))
    .map(([name]) => name)
  const drift = (plan.resource_drift ?? []).length
  const head = [
    changes.length === 0
      ? `Plan ${file}: no resource changes.`
      : `Plan ${file}: ${count('create')} to add, ${count('update')} to change, ${count('replace')} to replace, ${count('delete')} to destroy${imports > 0 ? `, ${imports} to import` : ''}${forgets > 0 ? `, ${forgets} to forget` : ''}.`,
    ...(drift > 0 ? [`Drift: ${drift} resources changed outside Terraform since the last apply.`] : []),
  ]

  const isDestructive = (one: Change) =>
    ['delete', 'replace'].includes(actionOf(one)) || one.change.actions.includes('forget')
  const destructive = changes.filter(isDestructive)
  const sensitive = changes.filter(one => !isDestructive(one) && SENSITIVE.test(one.type))
  const other = changes.filter(one => !isDestructive(one) && !SENSITIVE.test(one.type))
  const section = (title: string, list: Change[], max = Infinity) =>
    list.length === 0
      ? []
      : [
          `${title}:`,
          ...list.slice(0, max).map(lineOf),
          ...(list.length > max ? [`+ ${list.length - max} more`] : []),
        ]

  return [
    ...head,
    ...section('Destroy, replace or forget', destructive),
    ...section('Security-sensitive', sensitive),
    ...section('Other changes', other, MAX_OTHER),
    ...(outputs.length > 0 ? [`Outputs changing: ${outputs.join(', ')}`] : []),
  ].join('\n')
}

// `terraform show -json` can pass the 4 MiB a run keeps, so its output is streamed in whole.
const show = async ($: EngineInterface, cwd: string, file: string) => {
  const run = $.process.spawn({ argv: ['terraform', 'show', '-json', '-no-color', file], cwd })
  let stdout = ''
  let stderr = ''

  for await (const { stream, text } of run) {
    if (stream === 'stdout') {
      stdout += text
    } else {
      stderr += text
    }
  }

  return { code: (await run.result).code, stdout, stderr }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'plan_summary',
      description:
        'Summarizes a saved Terraform plan: counts, every destroy and replace, and IAM/KMS/security group/S3 policy changes, by attribute name only. Run terraform plan -out=FILE with its output sent to a log file, then call this instead of reading the plan output or terraform show.',
      inputSchema: {
        type: 'object',
        required: ['plan'],
        properties: {
          plan: { type: 'string', description: 'The saved plan file, relative to dir.' },
          dir: { type: 'string', description: 'The Terraform root folder; the session folder when left out.' },
        },
      },
    })

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const plan = typeof e.plan === 'string' ? e.plan.trim() : ''
    const dir = typeof e.dir === 'string' ? e.dir.trim() : ''

    // No shell runs, but a leading dash would still reach terraform as a flag.
    if (plan === '' || plan.startsWith('-') || dir.startsWith('-')) {
      return { result: 'Give the saved plan file as plan, and the Terraform folder as dir.' }
    }

    // No shell runs, so nothing would expand it.
    if (dir.startsWith('~')) {
      return { result: 'Give dir as a full path or relative to the session folder; ~ is not expanded.' }
    }

    const root = await $.session.cwd()
    const cwd = dir === '' ? root : ABSOLUTE.test(dir) ? dir : `${root}/${dir}`

    try {
      const got = await show($, cwd, plan)

      // Only terraform's headline comes back: the rest of its output, or a parser's message, can quote the plan's values.
      if (got.code !== 0) {
        const headline = got.stderr.split('\n').find(line => line.startsWith('Error: '))?.slice(0, 160)

        return {
          result: `terraform show failed${headline ? `: ${headline}` : ''}. Check the plan file and that the folder ran terraform init.`,
        }
      }

      return { result: summarize(JSON.parse(got.stdout), plan) }
    } catch {
      return { result: 'Could not read the plan: terraform did not start, or its output was not plan JSON.' }
    }
  })
}
