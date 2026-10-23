import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { line, parse } from './register'
import type { Window } from './register'

// 2026-10-22, midday local time.
const NOW = new Date(2026, 9, 22, 12).getTime()
const COMPANION = 'node "/home/me/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs"'
const HOUR = 60 * 60 * 1000

// A 5-hour and a 7-day window, `used` percent each, resetting in `inHours`.
const windows = (fiveHour: number, week: number, inHours = 2): Window[] => [
  { used_percent: fiveHour, window_minutes: 300, resets_at: (NOW + inHours * HOUR) / 1000 },
  { used_percent: week, window_minutes: 10080, resets_at: (NOW + 72 * HOUR) / 1000 },
]

// One session log line the way Codex writes its rate-limit report.
const report = (w: Window[]) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: w[0], secondary: w[1] } } })

// Answers every command beneath the mod, serves today's session log with `usage` in it, keeps the store in memory and records what is shown.
const host = (on: On, usage?: Window[], env: Record<string, string> = {}, isNotifyStuck = false) => {
  const store: Record<string, unknown> = {}
  const status: (string | undefined)[] = []
  const notified: string[] = []
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('env.get', (_, e) => ({ value: ({ CODEX_HOME: '/codex', ...env } as Record<string, string | undefined>)[e.name] }))
  on('fs.list', (_, e) => ({
    value:
      usage !== undefined && e.path.replace(/\\/g, '/').endsWith('sessions/2026/10/22')
        ? [{ name: 'rollout-a.jsonl', kind: 'file', size: 100, mtimeMs: NOW, isLink: false }]
        : [],
  }))
  on('fs.read', () => ({ value: `{"type":"session_meta"}\n${report(usage!)}\n` }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notified.push(e.text)

    return isNotifyStuck ? new Promise<never>(() => {}) : { value: { isSent: true, channel: 'terminal' } }
  })

  return { status, notified }
}

test('the last rate-limit report of a log is read', () => {
  const log = [report(windows(10, 1)), report(windows(40, 5)), '{"type":"response_item"}'].join('\n')
  expect(parse(log)?.map(w => w.used_percent)).toEqual([40, 5])
  expect(parse('{"type":"session_meta"}')).toBeUndefined()
  expect(parse('{"rate_limits": broken')).toBeUndefined()
})

test('a report Codex is still writing is passed over for the last whole one', () => {
  const log = [report(windows(40, 5)), '{"payload":{"rate_limits":null}}', report(windows(60, 6)).slice(0, 50)].join('\n')
  expect(parse(log)?.map(w => w.used_percent)).toEqual([40, 5])
})

test('the line shows each window, its reset and the runs this session', () => {
  const got = line(windows(42, 13), NOW, 1)
  expect(got).toMatch(/^Codex 5h 42% \(resets \d{1,2}:\d{2} [AP]M\) · 7d 13% \(resets \w{3} \d{1,2}:\d{2} [AP]M\) · 1 run this session$/)
})

test('a window past the warning is marked, and one whose reset passed reads 0%', () => {
  expect(line(windows(85, 13), NOW, 3, { warnAt: 80, runLimit: 2 })).toMatch(/^⚠ Codex 5h 85% .* · 3 runs this session \(over 2\)$/)
  expect(line(windows(85, 13, -1), NOW, 0)).toMatch(/^Codex 5h 0% · 7d 13% /)
})

test('with no session log the line is the run count alone', () => {
  expect(line(undefined, NOW, 2)).toBe('Codex: 2 runs this session')
})

for (const command of [
  `${COMPANION} task --model gpt-6-astra --effort high < brief.md`,
  `${COMPANION} review --base main`,
  `${COMPANION} adversarial-review`,
  'Get-Content brief.md | codex exec --model gpt-6-astra -',
  'codex review',
  '& "C:/tools/codex.cmd" exec -',
  'codex -m gpt-6-astra exec --json -',
  'codex --model=gpt-6-astra review',
]) {
  test(`a run counts: ${command}`, async ($, on) => {
    const { status } = host(on, windows(20, 5))
    await $.tool.call({ tool: 'PowerShell', command })
    expect(status.at(-1)).toMatch(/^Codex 5h 20% .* · 1 run this session$/)
  })
}

for (const command of [`${COMPANION} status`, `${COMPANION} setup --json`, 'codex --version', 'git status']) {
  test(`does not count: ${command}`, async ($, on) => {
    const { status } = host(on, windows(20, 5))
    await $.tool.call({ tool: 'Bash', command })
    expect(status).toEqual([])
  })
}

test('past the warning the model is told after the run, and the user is notified once', async ($, on) => {
  const { notified } = host(on, windows(86, 13))
  const first = await $.tool.call({ tool: 'Bash', command: `${COMPANION} task` })
  const second = await $.tool.call({ tool: 'Bash', command: `${COMPANION} task` })
  expect(first.context?.[0]).toMatch(/^Codex 5h limit is 86% used, resets /)
  expect(second.context).toHaveLength(1)
  expect(notified).toHaveLength(1)
})

test('under the warning nothing is added for the model', async ($, on) => {
  host(on, windows(50, 13))
  const got = await $.tool.call({ tool: 'Bash', command: `${COMPANION} task` })
  expect(got.context).toBeUndefined()
})

test('a session start shows the usage', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const { status } = host(on, windows(30, 5))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(status.at(-1)).toMatch(/^Codex 5h 30% /)
})

test('a session start with no session logs shows nothing', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const { status } = host(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(status).toEqual([undefined])
})

test('runs that end together are each counted', async ($, on) => {
  const { status } = host(on, windows(20, 5), { CODEX_METER_SESSION_RUNS: '2' })
  await Promise.all([1, 2, 3].map(() => $.tool.call({ tool: 'Bash', command: `${COMPANION} task` })))
  expect(status.at(-1)).toMatch(/· 3 runs this session \(over 2\)$/)
})

test('the warning percent is read from CODEX_METER_WARN_PERCENT', async ($, on) => {
  const { status } = host(on, windows(85, 13), { CODEX_METER_WARN_PERCENT: '90' })
  const got = await $.tool.call({ tool: 'Bash', command: `${COMPANION} task` })
  expect(got.context).toBeUndefined()
  expect(status.at(-1)).toMatch(/^Codex 5h 85% /)
})

test('settings that are not numbers in range fall back to the defaults', async ($, on) => {
  const { status } = host(on, windows(85, 13), { CODEX_METER_WARN_PERCENT: 'high', CODEX_METER_SESSION_RUNS: '0' })
  for (let i = 0; i < 3; i++) {
    await $.tool.call({ tool: 'Bash', command: `${COMPANION} task` })
  }
  expect(status.at(-1)).toMatch(/^⚠ Codex 5h 85% .* · 3 runs this session$/)
})

test('a notification that never finishes does not hold up the run or the next count', async ($, on) => {
  const { status, notified } = host(on, windows(86, 13), {}, true)
  await $.tool.call({ tool: 'Bash', command: `${COMPANION} task` })
  await $.tool.call({ tool: 'Bash', command: `${COMPANION} task` })
  expect(notified).toHaveLength(1)
  expect(status.at(-1)).toMatch(/· 2 runs this session$/)
})
