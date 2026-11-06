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
  // The companion's reviews have no --effort: only the model is required.
  ['a companion review with the model', `${COMPANION} review --model gpt-6-astra`, true],
  ['an adversarial review with the model', `${COMPANION} adversarial-review --model gpt-6-astra check auth`, true],
  ['a companion review with no model', `${COMPANION} review`, false],
  ['an adversarial review on another model', `${COMPANION} adversarial-review --model gpt-6.1-sol`, false],
  ['the CLI review still needs the effort', `codex review --model gpt-6-astra`, false],
  // Found in Codex review: the companion reads -m, -model and --m as the model, and the last one wins.
  ['a review that switches model with -m', `${COMPANION} review --model gpt-6-astra -m gpt-6.1-sol`, false],
  ['a task that switches model with -model', `${COMPANION} task ${ARGS} -model gpt-6.1-sol`, false],
  ['a task that switches model with --m=', `${COMPANION} task ${ARGS} --m=gpt-6.1-sol`, false],
  ['a task that switches effort with -effort', `${COMPANION} task ${ARGS} -effort low`, false],
  ['a task on the model given as -m', `${COMPANION} task -m gpt-6-astra --effort high`, true],
  ['a task whose -m= the companion ignores', `${COMPANION} task --model gpt-6.1-sol --effort high -m=gpt-6-astra`, false],
  ['a task whose -effort= the companion ignores', `${COMPANION} task --model gpt-6-astra --effort low -effort=high`, false],
  ['a task behind a Node flag with a value', `node --require node:fs "C:/x/codex-companion.mjs" task --model gpt-6.1-sol`, false],
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
  // Found in Codex review: after -e, -p or -, a companion path is only an argument to the code.
  ['eval code given the companion path as an argument', 'node -e "console.log(process.argv)" codex-companion.mjs task', true],
  ['print code given the companion path as an argument', 'node --print=1 C:/x/codex-companion.mjs task', true],
  ['stdin code given the companion path as an argument', 'node - C:/x/codex-companion.mjs task < x.js', true],
  ['a task whose own prompt holds -e', `${COMPANION} task --model gpt-6.1-sol -e x`, false],
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
