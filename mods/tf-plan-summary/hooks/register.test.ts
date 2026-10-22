import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const change = (address: string, actions: string[], before: object | null, after: object | null, extra: object = {}) => ({
  address,
  type: address.split('.')[0],
  change: { actions, before, after, after_unknown: {}, ...extra },
})

const PLAN = {
  resource_changes: [
    change('aws_s3_bucket.logs', ['create'], null, { bucket: 'logs' }),
    change('aws_instance.web', ['update'], { instance_type: 't3.micro', tags: {} }, { instance_type: 't3.small', tags: {} }),
    change('aws_db_instance.main', ['delete', 'create'], { engine_version: '15' }, { engine_version: '16' }, { replace_paths: [['engine_version']] }),
    change('aws_sqs_queue.old', ['delete'], { name: 'old' }, null),
    change('aws_iam_role.app', ['update'], { assume_role_policy: '{}', name: 'app' }, { assume_role_policy: '{"x":1}', name: 'app' }),
    // A secret in the plan must never reach the summary: only the attribute's name does.
    change('aws_secretsmanager_secret_version.db', ['update'], { secret_string: 'hunter2' }, { secret_string: 'hunter3' }),
    change('aws_vpc.main', ['no-op'], {}, {}),
    change('data.aws_caller_identity.me', ['read'], null, {}),
  ],
  resource_drift: [change('aws_s3_bucket.x', ['update'], {}, {})],
  output_changes: { bucket_arn: { actions: ['create'] }, same: { actions: ['no-op'] } },
}

// Answers terraform beneath the mod: the plan as JSON, or a failure.
const terraform = (on: On, answer: { code: number; stdout?: string; stderr?: string }) => {
  const runs: { argv: readonly string[]; cwd?: string }[] = []
  on('process.spawn', async function* (_, e) {
    runs.push({ argv: e.argv, cwd: e.cwd })
    // In pieces, as a stream would bring it.
    for (const text of [answer.stdout?.slice(0, 50), answer.stdout?.slice(50)].filter(Boolean)) {
      yield { stream: 'stdout' as const, text: text! }
    }
    if (answer.stderr) {
      yield { stream: 'stderr' as const, text: answer.stderr }
    }

    return { value: { code: answer.code, signal: null } }
  })
  on('session.cwd', () => ({ value: 'C:\\repos\\stack' }))
  on('tool.call', () => ({ result: '' }))

  return runs
}

const call = (input: { plan: string; dir?: string }) => ({
  tool: 'mcp__tf-plan-summary__plan_summary' as const,
  tool_use_id: 't1',
  ...input,
})

test('a plan comes back as counts, destroys, sensitive changes and the rest, without values', async ($, on) => {
  const runs = terraform(on, { code: 0, stdout: JSON.stringify(PLAN) })
  const got = await $.tool.call(call({ plan: 'tfplan' }))

  expect(runs).toEqual([{ argv: ['terraform', 'show', '-json', '-no-color', 'tfplan'], cwd: 'C:\\repos\\stack' }])
  expect(got.result).toBe(
    [
      'Plan tfplan: 1 to add, 3 to change, 1 to replace, 1 to destroy.',
      'Drift: 1 resources changed outside Terraform since the last apply.',
      'Destroy, replace or forget:',
      '- aws_db_instance.main: replace (forced by: engine_version)',
      '- aws_sqs_queue.old: delete',
      'Security-sensitive:',
      '- aws_iam_role.app: update (assume_role_policy)',
      '- aws_secretsmanager_secret_version.db: update (secret_string)',
      'Other changes:',
      '- aws_s3_bucket.logs: create',
      '- aws_instance.web: update (instance_type)',
      'Outputs changing: bucket_arn',
    ].join('\n'),
  )
  expect(String(got.result)).not.toContain('hunter')
})

test('a long plan lists 25 ordinary changes and counts the rest', async ($, on) => {
  const many = Array.from({ length: 30 }, (_, i) => change(`aws_sqs_queue.q${i}`, ['create'], null, {}))
  terraform(on, { code: 0, stdout: JSON.stringify({ resource_changes: many }) })
  const got = String((await $.tool.call(call({ plan: 'tfplan' }))).result)

  expect(got).toContain('- aws_sqs_queue.q24: create')
  expect(got).not.toContain('q25')
  expect(got.endsWith('+ 5 more')).toBe(true)
})

test('an empty plan says so', async ($, on) => {
  terraform(on, { code: 0, stdout: JSON.stringify({ resource_changes: [] }) })
  expect((await $.tool.call(call({ plan: 'tfplan' }))).result).toBe('Plan tfplan: no resource changes.')
})

test('a relative dir is taken from the session folder, an absolute one as given', async ($, on) => {
  const runs = terraform(on, { code: 0, stdout: '{}' })
  await $.tool.call(call({ plan: 'tfplan', dir: 'envs/prod' }))
  await $.tool.call(call({ plan: 'tfplan', dir: 'D:\\infra' }))

  expect(runs.map(one => one.cwd)).toEqual(['C:\\repos\\stack/envs/prod', 'D:\\infra'])
})

test('a terraform failure comes back as its last error lines', async ($, on) => {
  terraform(on, { code: 1, stderr: 'some detail with hunter2\nError: Failed to load plugin schemas\nmore hunter2\n' })
  expect((await $.tool.call(call({ plan: 'tfplan' }))).result).toBe(
    'terraform show failed: Error: Failed to load plugin schemas. Check the plan file and that the folder ran terraform init.',
  )
})

test('output that is not plan JSON never comes back quoted', async ($, on) => {
  terraform(on, { code: 0, stdout: 'password = hunter2' })
  const got = String((await $.tool.call(call({ plan: 'tfplan' }))).result)

  expect(got).toBe('Could not read the plan: terraform did not start, or its output was not plan JSON.')
})

test('forget, create-then-forget and import-only changes are listed and counted', async ($, on) => {
  terraform(on, {
    code: 0,
    stdout: JSON.stringify({
      resource_changes: [
        change('aws_s3_bucket.kept', ['forget'], {}, null),
        change('aws_instance.swap', ['create', 'forget'], {}, {}),
        change('aws_vpc.adopted', ['no-op'], {}, {}, { importing: { id: 'vpc-secret-id' } }),
      ],
    }),
  })
  const got = String((await $.tool.call(call({ plan: 'tfplan' }))).result)

  expect(got).toBe(
    [
      'Plan tfplan: 0 to add, 0 to change, 0 to replace, 0 to destroy, 1 to import, 2 to forget.',
      'Destroy, replace or forget:',
      '- aws_s3_bucket.kept: forget',
      '- aws_instance.swap: create+forget',
      'Other changes:',
      '- aws_vpc.adopted: import',
    ].join('\n'),
  )
  expect(got).not.toContain('vpc-secret-id')
})

test('a plan or dir that would pass for a flag never reaches terraform', async ($, on) => {
  const runs = terraform(on, { code: 0, stdout: '{}' })
  for (const input of [{ plan: '-help' }, { plan: 'tfplan', dir: '-chdir=/' }, { plan: '  ' }]) {
    expect(String((await $.tool.call(call(input))).result)).toMatch(/^Give the saved plan file/)
  }
  expect(String((await $.tool.call(call({ plan: 'tfplan', dir: '~/infra' }))).result)).toMatch(/~ is not expanded/)
  expect(runs).toEqual([])
})
