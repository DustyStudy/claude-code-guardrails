import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// The runs that spend the plan: the companion's review, adversarial-review and task, and the CLI's own exec and review.
// shortcut: matched on the command text, so `echo "codex exec"` counts too; harmless for a meter, parse it if that skews the count.
// The CLI may be a quoted path (& "C:/tools/codex.cmd" exec) and take flags first (codex -m gpt-6-astra exec).
const SPENDS =
  /codex-companion\.mjs["']?\s+(review|adversarial-review|task)\b|(^|[\s;&|(])["']?([^\s"';&|]*[\\/])?codex(\.exe|\.cmd|\.ps1)?["']?(\s+-{1,2}[\w-]+(=\S+|\s+(?!(exec|e|review)\b)[^\s-]\S*)?)*\s+(exec|e|review)\b/i
// A window this full gets the warning, unless CODEX_METER_WARN_PERCENT says otherwise.
const WARN_AT = 80
// Codex files its session logs under sessions/YYYY/MM/DD by the local day the session started.
const DAYS_SEARCHED = 7
const LOGS_READ = 3
// shortcut: $.fs.read rejects past 4 MiB, so a longer session log is skipped; read a newer or older one instead.
const MAX_READ = 4 * 1024 * 1024

// Runs this session (state is the session's own, and outlives a reload).
const session = atom({ plugin: 'codex-meter', key: 'session' } as const, 0)

/** One rate-limit window as Codex reports it after each turn. */
export type Window = { used_percent: number; window_minutes: number; resets_at: number }

/** When to warn: a window's used percent, and the runs one session may make (none set, no run warning). */
export type Settings = { warnAt: number; runLimit?: number }

const settings = async ($: EngineInterface): Promise<Settings> => {
  const warnAt = Number(await $.env.get('CODEX_METER_WARN_PERCENT'))
  const runLimit = Number(await $.env.get('CODEX_METER_SESSION_RUNS'))

  return {
    warnAt: warnAt > 0 && warnAt <= 100 ? warnAt : WARN_AT,
    runLimit: Number.isInteger(runLimit) && runLimit > 0 ? runLimit : undefined,
  }
}

// The local calendar day `back` days before `ms`, as YYYY-MM-DD; by calendar, so a daylight-saving day counts once.
const dayOf = (ms: number, back = 0) => {
  const day = new Date(ms)
  day.setDate(day.getDate() - back)

  return day.toLocaleDateString('en-CA')
}

// The windows of one log line, or undefined when it holds no whole report.
const windowsOf = (line: string): Window[] | undefined => {
  try {
    const limits = JSON.parse(line)?.payload?.rate_limits
    const windows = [limits?.primary, limits?.secondary].filter(
      (w): w is Window => typeof w?.used_percent === 'number' && typeof w?.window_minutes === 'number' && typeof w?.resets_at === 'number',
    )

    return windows.length > 0 ? windows : undefined
  } catch {
    return undefined
  }
}

/** The windows in the last whole rate-limit report of a session log, or undefined when it has none. */
export const parse = (log: string): Window[] | undefined => {
  // Newest first, past a line Codex is still writing or one with no windows.
  for (const line of log.split('\n').reverse()) {
    const windows = line.includes('"rate_limits"') ? windowsOf(line) : undefined
    if (windows !== undefined) {
      return windows
    }
  }

  return undefined
}

// The newest rate-limit report among the recent session logs.
const usage = async ($: EngineInterface, now: number): Promise<Window[] | undefined> => {
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

  return undefined
}

// 5h, 7d: how long the window is.
const span = (minutes: number) => (minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`)

// The used share now: a window whose reset has passed starts again at 0.
const usedNow = (w: Window, now: number) => (w.resets_at * 1000 <= now ? 0 : Math.round(w.used_percent))

// When the window resets: the time today, else the weekday too.
const resets = (w: Window, now: number) => {
  const at = new Date(w.resets_at * 1000)
  // Newer ICU puts a narrow no-break space before AM/PM.
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/ /g, ' ')

  return dayOf(at.getTime()) === dayOf(now) ? time : `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

/** The windows at or past the warning, as one sentence each. */
export const warnings = (windows: Window[], now: number, warnAt = WARN_AT) =>
  windows
    .filter(w => usedNow(w, now) >= warnAt)
    .map(w => `Codex ${span(w.window_minutes)} limit is ${usedNow(w, now)}% used, resets ${resets(w, now)}.`)

/** The status line: each window's use and reset, the runs this session, and a warning past either limit. */
export const line = (windows: Window[] | undefined, now: number, inSession: number, set: Settings = { warnAt: WARN_AT }) => {
  const over = set.runLimit !== undefined && inSession > set.runLimit ? ` (over ${set.runLimit})` : ''
  const runs = `${inSession} ${inSession === 1 ? 'run' : 'runs'} this session${over}`
  if (windows === undefined) {
    return `Codex: ${runs}`
  }
  const shown = windows.map(w => {
    const used = usedNow(w, now)

    return `${span(w.window_minutes)} ${used}%${used > 0 ? ` (resets ${resets(w, now)})` : ''}`
  })
  const mark = warnings(windows, now, set.warnAt).length > 0 ? '⚠ ' : ''

  return `${mark}Codex ${shown.join(' · ')} · ${runs}`
}

// Reads the usage, pins the line, and raises one notification per window that crosses the warning.
const show = async ($: EngineInterface) => {
  const now = await $.clock.now()
  const set = await settings($)
  const windows = await usage($, now)
  const inSession = await read($, session)

  // Nothing to say until Codex has run somewhere this week.
  $.ui.status(windows === undefined && inSession === 0 ? undefined : line(windows, now, inSession, set))

  const warned = ((await $.store.get('warned')) ?? []) as string[]
  const due = (windows ?? []).filter(w => usedNow(w, now) >= set.warnAt && !warned.includes(`${w.window_minutes}:${w.resets_at}`))
  if (due.length > 0) {
    // Only live windows are kept, so the list stays at a few entries.
    const live = warned.filter(k => Number(k.split(':')[1]) * 1000 > now)
    await $.store.set('warned', [...live, ...due.map(w => `${w.window_minutes}:${w.resets_at}`)])
    // Not awaited: a slow notification must not hold up the tool result or the next count.
    void $.ui.notify(warnings(due, now, set.warnAt).join(' '), { title: 'Codex usage' }).catch(() => undefined)
  }

  return windows === undefined ? [] : warnings(windows, now, set.warnAt)
}

let counting: Promise<unknown> = Promise.resolve()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await show($).catch(() => undefined)

    return next(e)
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const done = await next(e)

    if (done.deny !== undefined || !SPENDS.test(e.command)) {
      return done
    }

    // One count at a time, so runs that end together are each counted.
    const shown = counting.then(async () => {
      await update($, session, runs => runs + 1)

      return show($)
    })
    counting = shown.catch(() => undefined)
    const notes = await shown.catch(() => [] as string[])

    // The model is told after each run while a window is past the warning, so the next review can wait.
    return notes.length === 0 ? done : { ...done, context: [...(done.context ?? []), ...notes] }
  })
}
