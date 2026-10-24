import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ARGS = '--model gpt-6-astra --effort high'
const COMPANION = 'node "C:/Users/me/.claude/plugins/codex/scripts/codex-companion.mjs"'

// Each command, and whether the guard lets it run when MODEL_GUARD_CODEX_ARGS is set.
const CASES: readonly (readonly [string, string, boolean])[] = [
  ['a companion task with both', `${COMPANION} task ${ARGS} < brief.md`, true],
  ['a companion task with the flags as one word', `${COMPANION} task --model=gpt-6-astra --effort=high`, true],
  ['a companion task with no flags', `${COMPANION} task < brief.md`, false],
  ['a companion task on another model', `${COMPANION} task --model gpt-6.1-sol --effort high`, false],
  ['a companion review missing the effort', `${COMPANION} review --model gpt-6-astra`, false],
  ['a companion status check', `${COMPANION} status`, true],
  ['the CLI exec with both', `codex exec ${ARGS} "review this"`, true],
  ['the CLI exec through a quoted path', '& "C:/tools/codex.cmd" exec "review this"', false],
  ['the CLI review after a cd', 'cd repo && codex review', false],
  ['a companion task that names another model last', `${COMPANION} task ${ARGS} --model gpt-6.1-sol`, false],
  ['a companion task whose flags sit in the prompt after --', `${COMPANION} task -- ${ARGS}`, false],
  ['a companion task behind a Node flag', `node --no-warnings "C:/x/codex-companion.mjs" task`, false],
  ['the CLI help for exec', 'codex exec --help', true],
  ['the CLI help command', 'codex help review', true],
  ['the CLI version check', 'codex --version', true],
  ['a login check', 'codex login status', true],
  ['prose naming a run', 'echo "codex exec is how it runs"', true],
  ['an unrelated node script', 'node scripts/test-all.mjs', true],
]

const host = (on: On, env: Record<string, string>) => {
  let hasRun = false

  mock.env(on, env)
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, () => {
    hasRun = true

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  return () => hasRun
}

for (const [name, command, isAllowed] of CASES) {
  test(name, async ($, on) => {
    const ran = host(on, { MODEL_GUARD_CODEX_ARGS: ARGS })
    const done = await $.tool.call({ tool: 'Bash', command })

    expect(ran()).toBe(isAllowed)
    expect(done.deny === undefined).toBe(isAllowed)
  })
}

test('the deny names what is missing', async ($, on) => {
  host(on, { MODEL_GUARD_CODEX_ARGS: ARGS })
  const done = await $.tool.call({ tool: 'PowerShell', command: `${COMPANION} task --model gpt-6-astra` })

  expect(done.deny).toMatch(/missing --effort high\./)
})

test('no setting, no Codex check', async ($, on) => {
  const ran = host(on, {})

  await $.tool.call({ tool: 'Bash', command: `${COMPANION} task` })

  expect(ran()).toBe(true)
})

// The model each spawn starts on, as the engine beneath the guard sees it.
const spawned = (on: On, env: Record<string, string>) => {
  const models: (string | undefined)[] = []

  mock.env(on, env)
  on('agent.spawn', (_, e) => {
    models.push(e.model)

    return { model: e.model ?? 'inherit' }
  })

  return models
}

test('a subagent with no model, or another one, starts on the pinned model', async ($, on) => {
  const models = spawned(on, { MODEL_GUARD_SUBAGENT_MODEL: 'opus' })

  await $.agent.spawn({ prompt: 'look', subagentType: 'Explore' })
  await $.agent.spawn({ prompt: 'look', subagentType: 'Explore', model: 'haiku' })
  await $.agent.spawn({ prompt: 'look', subagentType: 'general-purpose', model: 'opus' })

  expect(models).toEqual(['opus', 'opus', 'opus'])
})

test('no setting leaves the model as the call gave it', async ($, on) => {
  const models = spawned(on, {})

  await $.agent.spawn({ prompt: 'look', model: 'haiku' })

  expect(models).toEqual(['haiku'])
})

test('a fork keeps its call as it was', async ($, on) => {
  const models = spawned(on, { MODEL_GUARD_SUBAGENT_MODEL: 'opus' })

  await $.agent.spawn({ prompt: 'look', subagentType: 'fork' })

  expect(models).toEqual([undefined])
})
