import { expect, mock, test } from 'claude-code/testing'

import { heat, parse, until } from './register'

const NOW = new Date(2026, 9, 31, 12).getTime()
const HOUR = 60 * 60 * 1000
const CODEX_LOG = JSON.stringify({
  payload: {
    rate_limits: {
      primary: { used_percent: 12.4, window_minutes: 300, resets_at: (NOW + 2 * HOUR) / 1000 },
      secondary: { used_percent: 85, window_minutes: 10080, resets_at: (NOW + 72 * HOUR) / 1000 },
    },
  },
})

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('a Codex log yields its last whole report', () => {
  expect(parse(`{"type":"x"}\n${CODEX_LOG}\n{"rate_limits": trunc`)?.map(w => w.used_percent)).toEqual([12.4, 85])
  expect(parse('{"type":"x"}')).toBeUndefined()
})

test('colours and reset times', () => {
  expect([heat(76), heat(50), heat(21), heat(20), heat(0)]).toEqual(['success', 'warning', 'warning', 'error', 'error'])
  expect(until(NOW + 42 * 60 * 1000, NOW)).toBe('42m')
  expect(until(NOW + 3 * HOUR + 10 * 60 * 1000, NOW)).toBe('3h 10m')
  expect(until(NOW + 81 * HOUR, NOW)).toBe('3d 9h')
  expect(until(NOW - 1, NOW)).toBe('resetting')
})

test('the band shows Claude and Codex usage on desktop only', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('env.get', (_, e) => ({ value: e.name === 'CODEX_HOME' ? '/codex' : undefined }))
  on('fs.list', (_, e) => ({
    value: e.path.replace(/\\/g, '/').endsWith('sessions/2026/10/31') ? [{ name: 'rollout-a.jsonl', kind: 'file', size: 100, mtimeMs: NOW, isLink: false }] : [],
  }))
  on('fs.read', () => ({ value: CODEX_LOG }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }, { kind: 'seven_day', percentUsed: 41 }] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Stands for the engine's own band beneath the mod.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: 'Claude' }))?.text).toBe('Claude')
  // Claude's 5h at 23.5% used has 76% left; Codex's 7d at 85% used has 15% left.
  expect((await desktop.findAll({ type: 'Text', text: /^\d+%$/ })).map(t => t.text)).toEqual(['76%', '59%', '88%', '15%'])
  expect((await desktop.findAll({ type: 'Text', text: /^resets / })).map(t => t.text)).toContain('resets 2h 0m')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: 'Claude' })).toBeUndefined()
  await terminal.unmount()
})

// Serves today's Codex log with a 5-hour window `used` percent used, keeps the store in memory and records notifications.
const codexHost = (on: Parameters<Parameters<typeof test>[1]>[1], used: number) => {
  const store: Record<string, unknown> = {}
  const notified: string[] = []
  const log = JSON.stringify({
    payload: { rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: (NOW + 2 * HOUR) / 1000 } } },
  })
  mock.clock(on, { now: NOW })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('env.get', (_, e) => ({ value: e.name === 'CODEX_HOME' ? '/codex' : undefined }))
  on('fs.list', (_, e) => ({
    value: e.path.replace(/\\/g, '/').endsWith('sessions/2026/10/31') ? [{ name: 'rollout-a.jsonl', kind: 'file', size: 100, mtimeMs: NOW, isLink: false }] : [],
  }))
  on('fs.read', () => ({ value: log }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    notified.push(e.text)

    return { value: { isSent: true, channel: 'terminal_bell' } }
  })

  return notified
}

test('a Codex run with a window nearly out tells the model each time and notifies the user once', async ($, on) => {
  const notified = codexHost(on, 85)
  const first = await $.tool.call({ tool: 'PowerShell', command: 'Get-Content brief.md | codex exec --model gpt-6-astra -' })
  const second = await $.tool.call({ tool: 'Bash', command: 'node scripts/codex-companion.mjs task' })

  expect(first.context?.[0]).toBe('usage-band: Codex 5h limit has 15% left, resets in 2h 0m.')
  expect(second.context).toHaveLength(1)
  expect(notified).toEqual(['Codex 5h limit has 15% left, resets in 2h 0m.'])
})

test('a Codex run with room left, or a command that is not a run, adds nothing', async ($, on) => {
  codexHost(on, 50)
  expect((await $.tool.call({ tool: 'Bash', command: 'codex exec -' })).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'codex --version' })).context).toBeUndefined()
})

test('Codex runs that end together notify once', async ($, on) => {
  const notified = codexHost(on, 90)
  await Promise.all([1, 2, 3].map(() => $.tool.call({ tool: 'Bash', command: 'codex exec -' })))
  expect(notified).toHaveLength(1)
})
