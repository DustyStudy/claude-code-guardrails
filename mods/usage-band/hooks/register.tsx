import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClaudeLimit, Window } from '../types'

// The terminal already shows usage in statusline.js and codex-meter's status line; Desktop draws neither, so the band is Desktop's alone.
const SURFACES = ['desktop']
// Codex files its session logs under sessions/YYYY/MM/DD by the local day the session started (as codex-meter reads them).
const DAYS_SEARCHED = 7
const LOGS_READ = 3
// $.fs.read rejects past 4 MiB.
const MAX_READ = 4 * 1024 * 1024
// A window with less than this share left is flagged LOW.
const LOW_AT = 15
const MINUTE = 60 * 1000

const claude = atom({ plugin: 'usage-band', key: 'claude' } as const, [] as ClaudeLimit[])
const codex = atom({ plugin: 'usage-band', key: 'codex' } as const, [] as Window[])
const tick = atom({ plugin: 'usage-band', key: 'tick' } as const, 0)

/** One window: its span, the share left, and when it resets (ms), if known. */
export type Bar = { span: string; left: number; resetsAt?: number }

const span = (minutes: number) => (minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`)
const CLAUDE_SPANS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

export const claudeBars = (limits: ClaudeLimit[]): Bar[] =>
  limits.map(l => ({
    span: CLAUDE_SPANS[l.kind] ?? l.kind,
    left: Math.max(0, Math.floor(100 - l.percentUsed)),
    resetsAt: l.resetsAt === undefined ? undefined : Date.parse(l.resetsAt) || undefined,
  }))

// A Codex window whose reset has passed starts again full.
export const codexBars = (windows: Window[], now: number): Bar[] =>
  windows.map(w => ({
    span: span(w.window_minutes),
    left: w.resets_at * 1000 <= now ? 100 : Math.max(0, Math.round(100 - w.used_percent)),
    resetsAt: w.resets_at * 1000,
  }))

/** Green with plenty left, orange past half used, red when nearly out: statusline.js's thresholds (50% and 80% used), read as share left. */
export const heat = (left: number) => (left <= 20 ? 'error' : left <= 50 ? 'warning' : 'success')

/** How long until `at`: 42m, 3h 10m, 2d 5h; "resetting" once passed, "" when unknown. */
export const until = (at: number | undefined, now: number) => {
  if (at === undefined) {
    return ''
  }
  const minutes = Math.ceil((at - now) / MINUTE)
  if (minutes <= 0) {
    return 'resetting'
  }

  return minutes < 60
    ? `${minutes}m`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
}

const dayOf = (ms: number, back = 0) => {
  const day = new Date(ms)
  day.setDate(day.getDate() - back)

  return day.toLocaleDateString('en-CA')
}

/** The windows in the last whole rate-limit report of a Codex session log, or undefined when it has none. */
export const parse = (log: string): Window[] | undefined => {
  for (const line of log.split('\n').reverse()) {
    if (!line.includes('"rate_limits"')) {
      continue
    }
    try {
      const limits = JSON.parse(line)?.payload?.rate_limits
      const windows = [limits?.primary, limits?.secondary].filter(
        (w): w is Window => typeof w?.used_percent === 'number' && typeof w?.window_minutes === 'number' && typeof w?.resets_at === 'number',
      )
      if (windows.length > 0) {
        return windows
      }
    } catch {
      // A line Codex is still writing.
    }
  }

  return undefined
}

// The newest Codex rate-limit report among the recent session logs; none when Codex has not run this week.
const codexUsage = async ($: EngineInterface): Promise<Window[]> => {
  const now = await $.clock.now()
  const home =
    (await $.env.get('CODEX_HOME')) ??
    [(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '', '.codex'].join('/')
  const sep = home.includes('\\') ? '\\' : '/'
  const logs: { path: string; mtimeMs: number }[] = []

  for (let back = 0; back < DAYS_SEARCHED; back++) {
    const dir = [home, 'sessions', ...dayOf(now, back).split('-')].join(sep)
    for (const entry of await $.fs.list(dir).catch(() => [])) {
      if (entry.kind === 'file' && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl') && entry.size <= MAX_READ) {
        logs.push({ path: dir + sep + entry.name, mtimeMs: entry.mtimeMs })
      }
    }
  }

  for (const log of logs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, LOGS_READ)) {
    const windows = parse(await $.fs.read(log.path).then(String, () => ''))
    if (windows !== undefined) {
      return windows
    }
  }

  return []
}

const refresh = async ($: EngineInterface) => {
  const [usage, windows] = await Promise.all([$.session.usage().catch(() => undefined), codexUsage($).catch(() => [])])
  if (usage !== undefined) {
    await update($, claude, () => usage.rateLimits)
  }
  await update($, codex, () => windows)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const done = await next(e)
    await refresh($).catch(() => undefined)
    // Redraws the reset countdowns while the session sits idle.
    $.clock.every(30 * 1000, () => void update($, tick, n => n + 1))

    return done
  })

  on('session.measure', async ($, e, next) => {
    await update($, claude, () => e.rateLimits)

    return next(e)
  })

  // A Codex run ends inside a turn, so its log is read again once the turn is done.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($).catch(() => undefined)

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!SURFACES.includes(e.surface) || e.props.hasSurvey) {
      return next(e)
    }

    // Read so the timer's tick redraws the countdowns.
    await read($, tick)
    const now = await $.clock.now()
    const groups = [
      { name: 'Claude', bars: claudeBars(await read($, claude)) },
      { name: 'Codex', bars: codexBars(await read($, codex), now) },
    ].filter(g => g.bars.length > 0)
    if (groups.length === 0) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box columnGap={3} flexWrap="wrap">
          {groups.map(g => (
            <Box key={g.name} columnGap={2}>
              <Text weight="semibold">{g.name}</Text>
              {g.bars.map(b => (
                <Box key={b.span} columnGap={1}>
                  <Text dimColor>{b.span}</Text>
                  <Text color={heat(b.left)}>{`${b.left}%`}</Text>
                  {b.left < LOW_AT ? (
                    <Text color="error" weight="semibold">
                      LOW
                    </Text>
                  ) : null}
                  {b.resetsAt === undefined ? null : <Text dimColor>{`resets ${until(b.resetsAt, now)}`}</Text>}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
        {await next(e)}
      </Box>
    )
  })
}
