import type { On } from 'claude-code'
import { type Engine as Raise, expect, mock, test } from 'claude-code/testing'

import { LIMIT } from './register'

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
  // The CLI has no --effort: it takes the effort, and can take the model, through -c.
  ['the CLI exec with the effort through -c', 'codex exec --model gpt-6-astra -c model_reasoning_effort=high "x"', true],
  ['the CLI exec with both through -c', 'codex exec -c model=gpt-6-astra --config=model_reasoning_effort=high "x"', true],
  ['the CLI exec with the model as -mx', 'codex exec -mgpt-6-astra -c model_reasoning_effort=high "x"', true],
  ['the CLI exec that switches model with -c', 'codex exec --model gpt-6-astra -c model=gpt-6.1-sol -c model_reasoning_effort=high "x"', false],
  ['the CLI exec that switches model before --model', 'codex -c model=gpt-6.1-sol exec --model gpt-6-astra -c model_reasoning_effort=high "x"', false],
  ['the CLI exec that switches model with -m=', 'codex exec --model gpt-6-astra -m=gpt-6.1-sol -c model_reasoning_effort=high "x"', false],
  ['the CLI exec that switches model with -mx', 'codex exec --model gpt-6-astra -mgpt-6.1-sol -c model_reasoning_effort=high "x"', false],
  ['the CLI exec that switches effort with -c', `codex exec ${ARGS} -c model_reasoning_effort=low "x"`, false],
  ['the CLI exec on a profile', 'codex exec --model gpt-6-astra -c model_reasoning_effort=high -p fast "x"', false],
  ['the CLI exec on a local model', 'codex exec --model gpt-6-astra -c model_reasoning_effort=high --oss "x"', false],
  ['the CLI exec on another provider', 'codex exec --model gpt-6-astra -c model_reasoning_effort=high -c model_provider=other "x"', false],
  // Found in Codex review.
  ['the CLI exec that switches effort with -c=', 'codex exec -m gpt-6-astra -c model_reasoning_effort=high -c=model_reasoning_effort=low x', false],
  ['the CLI exec whose prompt is help', 'codex exec -m gpt-6.1-sol -- help', false],
  ['the CLI queue to a saved session', 'codex queue --thread abc --message "go on"', false],
  ['the CLI resume with a prompt', 'codex resume --last "go on"', false],
  ['the CLI fork with a prompt', 'codex fork --last "go on"', false],
  ['the CLI resume on the model', 'codex resume --last -m gpt-6-astra -c model_reasoning_effort=high "go on"', true],
  ['the CLI cloud task list', 'codex cloud list', true],
  ['the CLI exec with an unrelated -c', 'codex exec --model gpt-6-astra -c model_reasoning_effort=high -c sandbox_mode=read-only "x"', true],
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
  // Found in red-team review: a prompt with no subcommand runs the interactive CLI, and a package runner runs the CLI by its package name.
  ['the interactive CLI with a prompt', 'codex "fix the bug"', false],
  ['the interactive CLI on another model', 'codex -m gpt-6.1-sol "fix the bug"', false],
  ['the interactive CLI with both', 'codex -m gpt-6-astra -c model_reasoning_effort=high "fix the bug"', true],
  ['the CLI through npx', 'npx -y @openai/codex@latest exec "x"', false],
  ['the CLI through npm exec', 'npm exec -- @openai/codex exec -m gpt-6.1-sol "x"', false],
  ['the CLI through npx with both', 'npx @openai/codex exec -m gpt-6-astra -c model_reasoning_effort=high "x"', true],
  ['a CLI review that switches model with -c review_model', 'codex review -m gpt-6-astra -c model_reasoning_effort=high -c review_model=gpt-6.1-sol', false],
  ['the CLI exec that switches model with a padded -c key', 'codex exec -m gpt-6-astra -c model_reasoning_effort=high -c " model = gpt-6.1-sol" x', false],
  // The companion takes the word after --cwd or --prompt-file as its value, so a --model there is no flag.
  ['a task whose last --model is the value of --prompt-file', `${COMPANION} task --model gpt-6.1-sol --prompt-file --model gpt-6-astra --effort high`, false],
  ['a task whose only --model is the value of --cwd', `${COMPANION} task --cwd --model gpt-6-astra --effort high`, false],
  ['a task with a real --cwd', `${COMPANION} task --cwd repo ${ARGS}`, true],
  ['a companion task run by bun', 'bun "C:/x/codex-companion.mjs" task', false],
  ['a lookup of the CLI', 'command -v codex', true],
  ['an install of the CLI', 'sudo npm install -g @openai/codex', true],
  ['the bare interactive CLI', 'codex', true],
  ['the CLI doctor', 'codex doctor', true],
  ['the CLI MCP list', 'codex mcp list', true],
  ['the CLI apply', 'codex apply abc123', true],
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

// Monitor and the desktop app's terminal tool hand a command line to a shell too: they are checked like Bash.
for (const tool of ['Monitor', 'mcp__terminal__run_in_terminal']) {
  test(`${tool} is denied what Bash is, and runs the rest`, async ($, on) => {
    mock.env(on, { MODEL_GUARD_CODEX_ARGS: ARGS })
    const ran: string[] = []

    on('tool.call', { tool: [tool] }, (_, e) => {
      ran.push(String(e.command))

      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const denied = JSON.stringify(await $.tool.call({ tool, command: `${COMPANION} task` } as never))
    await $.tool.call({ tool, command: 'git status' } as never)
    // A Monitor that opens a WebSocket has no command.
    await $.tool.call({ tool, ws: { url: 'wss://example.com/events' } } as never)

    expect(ran).toEqual(['git status', 'undefined'])
    expect(denied).toContain('model-guard: ')
    expect(denied).not.toContain('guard failed')
  })
}

// A second Claude started from the shell, or a session started from this one, is a way around the subagent pin.
const CLAUDE_CASES: readonly (readonly [string, boolean])[] = [
  ['claude -p --model sonnet "look"', false],
  ['claude --model=haiku -p "look"', false],
  [`claude -p "look" --agents '{"scout":{"description":"x","prompt":"y","model":"haiku"}}'`, false],
  ['claude -p --model opus "look"', true],
  ['claude -p "look"', true],
  ['claude -p "which model: sonnet or haiku?"', true],
  [`claude -p "look" --agents '{"scout":{"description":"x","prompt":"y","model":"opus"}}'`, true],
  ['claude --version', true],
  ['claude plugin test mods/model-guard', true],
]

for (const [command, isAllowed] of CLAUDE_CASES) {
  test(`${isAllowed ? 'runs' : 'denies'} ${command}`, async ($, on) => {
    const ran = host(on, { MODEL_GUARD_SUBAGENT_MODEL: 'opus' })
    const done = await $.tool.call({ tool: 'Bash', command })

    expect(ran()).toBe(isAllowed)
    expect(done.deny === undefined).toBe(isAllowed)
  })
}

test('a session started from this one inherits its model, whatever the call names', async ($, on) => {
  mock.env(on, { MODEL_GUARD_SUBAGENT_MODEL: 'opus' })
  const models: unknown[] = []

  on('tool.call', { tool: ['mcp__ccd_session__start_session'] }, (_, e) => {
    models.push((e as { model?: unknown }).model)

    return { result: {} as never }
  })

  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x', prompt: 'y', model: 'claude-haiku-4-5' } as never)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', title: 'x', prompt: 'y' } as never)

  expect(models).toEqual([undefined, undefined])
})

// The fallback: subagents move off the pinned model while it is out of usage, and back when it resets.
const FALLBACK = { MODEL_GUARD_SUBAGENT_MODEL: 'fable', MODEL_GUARD_FALLBACK_MODEL: 'opus', MODEL_GUARD_FALLBACK_EFFORT: 'high' }
const NOW = Date.parse('2026-01-01T00:00:00Z')
const HOUR = 60 * 60 * 1000
const LIMIT_TEXT = 'You have hit your limit for this model.'

type Window = { kind: string; percentUsed: number; resetsAt?: string }

// A session whose subagent's last message is text and whose account has these windows: the requests and notices beneath the guard.
const session = (on: On, env: Record<string, string>, text = LIMIT_TEXT, rateLimits: Window[] = []) => {
  const steps: string[] = []
  const logs: string[] = []

  mock.env(on, env)
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })

  on('turn.step', async function* (_, e) {
    steps.push(`${e.model} ${e.effort}`)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text, toolUses: [] }] }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: {} as never, rateLimits } }))
  on('ui.log', (_, e) => {
    logs.push(e.text)

    return { value: undefined }
  })

  return { steps, logs, clock }
}

const step = async ($: Raise, agentId?: string, model = 'claude-fable-5-2') => {
  const stream = $.turn.step({ turnId: 't', index: 0, model, effort: 'medium', messageCount: 1, ...(agentId === undefined ? {} : { agentId }) })

  for await (const _ of stream) {
    // No chunks beneath.
  }

  await stream.result
}

// A subagent makes a request on the pinned model, then its turn dies on an API error.
const fail = async ($: Raise, agentId = 'a1') => {
  await step($, agentId)
  await $.turn.complete({ turnId: 't', agentId, reason: 'error', answer: '', durationMs: 1, isAborted: false })
}

test('with no limit hit, a subagent request goes out on the pinned model', async ($, on) => {
  const { steps, logs } = session(on, FALLBACK)

  await step($, 'a1')

  expect(steps).toEqual(['claude-fable-5-2 medium'])
  expect(logs).toEqual([])
})

test('a limit error moves the next subagent request to the fallback model and effort, with one notice', async ($, on) => {
  const { steps, logs } = session(on, FALLBACK)

  await fail($)
  await step($, 'a2')
  await $.turn.complete({ turnId: 't', agentId: 'a1', reason: 'error', answer: '', durationMs: 1, isAborted: false })
  await step($, 'a3')

  expect(steps).toEqual(['claude-fable-5-2 medium', 'opus high', 'opus high'])
  expect(logs).toEqual([`model-guard: fable is out of usage until ${new Date(NOW + 5 * HOUR).toISOString()}; subagents run on opus at high effort until then.`])
})

test('no fallback effort switches the model alone', async ($, on) => {
  const { steps } = session(on, { MODEL_GUARD_SUBAGENT_MODEL: 'fable', MODEL_GUARD_FALLBACK_MODEL: 'opus' })

  await fail($)
  await step($, 'a2')

  expect(steps.at(-1)).toBe('opus medium')
})

test('after the reset time, subagents are back on the pinned model, with one notice', async ($, on) => {
  const { steps, logs, clock } = session(on, FALLBACK)

  await fail($)
  await clock.advance(5 * HOUR)
  await step($, 'a2')
  await step($, 'a2')

  expect(steps.slice(1)).toEqual(['claude-fable-5-2 medium', 'claude-fable-5-2 medium'])
  expect(logs.slice(1)).toEqual(['model-guard: subagents are back on fable.'])
})

test('a fork on the session model and the main loop are untouched while the pinned model is out', async ($, on) => {
  const { steps } = session(on, FALLBACK)

  await fail($)
  await step($, 'fork1', 'claude-opus-5-5')
  await step($, undefined, 'claude-opus-5-5')
  await step($)

  expect(steps.slice(1)).toEqual(['claude-opus-5-5 medium', 'claude-opus-5-5 medium', 'claude-fable-5-2 medium'])
})

test('no fallback model, no switch', async ($, on) => {
  const { steps, logs } = session(on, { MODEL_GUARD_SUBAGENT_MODEL: 'fable' })

  await fail($)
  await step($, 'a2')

  expect(steps.at(-1)).toBe('claude-fable-5-2 medium')
  expect(logs).toEqual([])
})

test('an error that is no limit switches nothing', async ($, on) => {
  const { steps, logs } = session(on, FALLBACK, 'API Error: 500 Internal server error')

  await fail($)
  await step($, 'a2')

  expect(steps.at(-1)).toBe('claude-fable-5-2 medium')
  expect(logs).toEqual([])
})

test('an error of an agent that never ran on the pinned model switches nothing', async ($, on) => {
  const { steps } = session(on, FALLBACK)

  await step($, 'fork1', 'claude-opus-5-5')
  await $.turn.complete({ turnId: 't', agentId: 'fork1', reason: 'error', answer: '', durationMs: 1, isAborted: false })
  await step($, 'a2')

  expect(steps.at(-1)).toBe('claude-fable-5-2 medium')
})

test('the reset time is read from the error text', async ($, on) => {
  const at = NOW + 2 * HOUR
  const { logs } = session(on, FALLBACK, `Claude AI usage limit reached|${at / 1000}`)

  await fail($)

  expect(logs[0]).toContain(new Date(at).toISOString())
})

test('the reset time is read from a full window, the one named for the model first', async ($, on) => {
  const { logs } = session(on, FALLBACK, 'API Error: 500 Internal server error', [
    { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-01-01T03:00:00.000Z' },
    { kind: 'seven_day_fable', percentUsed: 100, resetsAt: '2026-01-04T00:00:00.000Z' },
    { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-01-06T00:00:00.000Z' },
  ])

  await fail($)

  expect(logs[0]).toContain('until 2026-01-04T00:00:00.000Z;')
})

test('another error while only an account-wide window is full switches nothing', async ($, on) => {
  const { steps, logs } = session(on, FALLBACK, 'API Error: 500 Internal server error', [
    { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-01-01T03:00:00.000Z' },
  ])

  await fail($)
  await step($, 'a2')

  expect(steps.at(-1)).toBe('claude-fable-5-2 medium')
  expect(logs).toEqual([])
})

test('with no window named for the model, the latest full one gives the reset time', async ($, on) => {
  const { logs } = session(on, FALLBACK, LIMIT_TEXT, [
    { kind: 'five_hour', percentUsed: 100, resetsAt: '2026-01-01T03:00:00.000Z' },
    { kind: 'seven_day', percentUsed: 100, resetsAt: '2026-01-06T00:00:00.000Z' },
  ])

  await fail($)

  expect(logs[0]).toContain('until 2026-01-06T00:00:00.000Z;')
})

test('a reset time in the past is ignored for the five-hour default', async ($, on) => {
  const { logs } = session(on, FALLBACK, 'Claude AI usage limit reached|1700000000')

  await fail($)

  expect(logs[0]).toContain(new Date(NOW + 5 * HOUR).toISOString())
})

// The CLI's message when a subagent ran out of Fable, as seen in a real run.
const REAL =
  "API Error: You've hit your Fable limit · resets 4pm (America/Chicago). Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue. (error type rate_limit, HTTP 429)"

test('the real limit message flips to the fallback until its time of day in its zone', async ($, on) => {
  const { steps, logs } = session(on, FALLBACK, REAL)

  await fail($)
  await step($, 'a2')

  // NOW is 6pm the day before in Chicago (UTC-6 in January), so the next 4pm there is 22:00 UTC.
  expect(logs).toEqual(['model-guard: fable is out of usage until 2026-01-01T22:00:00.000Z; subagents run on opus at high effort until then.'])
  expect(steps.at(-1)).toBe('opus high')
})

test('side-by-side subagents that hit the limit, then come back, say each once', async ($, on) => {
  const { logs, clock } = session(on, FALLBACK)

  await Promise.all([step($, 'a1'), step($, 'a2')])
  await Promise.all(['a1', 'a2'].map(agentId => $.turn.complete({ turnId: 't', agentId, reason: 'error', answer: '', durationMs: 1, isAborted: false })))
  await clock.advance(5 * HOUR)
  await Promise.all([step($, 'a3'), step($, 'a4')])

  expect(logs.length).toBe(2)
  expect(logs[1]).toBe('model-guard: subagents are back on fable.')
})

test('the limit wording matches loosely', () => {
  for (const text of [REAL, 'Rate limit exceeded', 'usage limit reached', '429 Too Many Requests', 'You are out of extra usage']) {
    expect(LIMIT.test(text)).toBe(true)
  }

  expect(LIMIT.test('API Error: 500 Internal server error')).toBe(false)
})
