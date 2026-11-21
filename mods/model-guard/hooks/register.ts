import type { EngineInterface, Register } from 'claude-code'

import { invocations } from './shell'

// Codex runs through the plugin's companion script (node codex-companion.mjs task) or the CLI itself.
const NODE = /^(.*[\\/])?(node|bun|deno)(\.exe)?$/i
const CODEX = /^(.*[\\/])?codex(\.exe|\.cmd|\.ps1)?$/i
// A package runner starts the CLI by its package name: npx @openai/codex exec, npm exec -- @openai/codex exec.
const NPX = /^(.*[\\/])?(npx|bunx|pnpx)(\.exe|\.cmd|\.ps1)?$/i
const NPM = /^(.*[\\/])?(npm|pnpm|yarn|bun)(\.exe|\.cmd|\.ps1)?$/i
const PACKAGE = /^(@openai\/)?codex(@[\w.-]+)?$/
const CLAUDE = /^(.*[\\/])?claude(\.exe|\.cmd|\.ps1)?$/i
const COMPANION_RUN = /^(task|review|adversarial-review)$/
// The companion's reviews take --model but no --effort (review rejects it, adversarial-review reads it as focus text), so Codex's configured effort applies.
const COMPANION_REVIEW = /^(review|adversarial-review)$/
// queue sends a message to a saved session, and resume or fork with a prompt runs one: each on a model it may not name.
const CLI_RUN = /^(exec|e|review|queue|resume|fork)$/
// With none of those, the first word is a subcommand that runs no model, or the call is the interactive CLI and its other words a prompt.
const CLI_OTHER =
  /^(agents|login|logout|mcp|mcp-server|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|a|archive|delete|migrate-rollouts|unarchive|cloud|exec-server|features|help)$/
// The companion's options that take the next word as their value, whatever it is: --cwd --model reads --model as a folder.
const COMPANION_VALUE = /^--?(cwd|C|prompt-file|base|scope)$/

// The flags and values a setting asks for, each flag with the value after it, if any: --model x --effort high.
const required = (setting: string) => {
  const words = setting.split(/\s+/).filter(Boolean)

  return words.flatMap((word, i) =>
    !word.startsWith('-') ? [] : [{ flag: word, value: words[i + 1]?.startsWith('-') ? undefined : words[i + 1] }],
  )
}

// Every spelling Codex or the companion reads as the flag: -x and --x alike, and -m or --m for the model.
const spellings = (flag: string) => {
  const name = flag.replace(/^-+/, '')

  return (name === 'model' ? [name, 'm'] : [name]).flatMap(one => [`-${one}`, `--${one}`])
}

// A flag with its value as one word (--model=x) or two (--model x). The last one given wins, or with every, each one must match; words
// after -- are the prompt.
const has = (all: readonly string[], { flag, value }: { flag: string; value?: string }, every = false) => {
  const args = all.includes('--') ? all.slice(0, all.indexOf('--')) : all
  const names = spellings(flag)

  if (value === undefined) {
    return args.some(arg => names.includes(arg))
  }

  const given = args.flatMap((arg, i) => {
    // Only a -- spelling takes its value after =: the companion reads -m=x as prompt text.
    const inline = names.find(name => name.startsWith('--') && arg.startsWith(`${name}=`))

    return names.includes(arg) ? [args[i + 1]] : inline ? [arg.slice(inline.length + 1)] : []
  })

  return every ? given.length > 0 && given.every(one => one === value) : given.at(-1) === value
}

// The CLI picks a model and effort in more ways than the companion: -c model=x, -c model_reasoning_effort=x, -mx and -m=x; and a
// profile, --oss or another provider picks a model of its own. Each becomes the --model or --effort it amounts to.
const cliArgs = (args: readonly string[]) => {
  const out: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''

    if (arg === '--') {
      out.push(...args.slice(i))
      break
    }

    const config = /^(-c|--config)$/.test(arg) ? args[++i] : /^(--config=|-c=?).+=/.test(arg) ? arg.replace(/^(--config=|-c=?)/, '') : undefined

    if (config !== undefined) {
      // Codex trims both sides of the =.
      const [key = '', ...rest] = config.split('=').map(one => one.trim())
      const value = rest.join('=')

      if (key === 'model' || key === 'review_model') {
        out.push('--model', value)
      } else if (key === 'model_reasoning_effort') {
        out.push('--effort', value)
      } else {
        out.push(...(/^(model_provider|profile)$/.test(key) ? ['--model', config] : ['-c', config]))
      }
    } else if (/^(-p|--profile|--local-provider)$/.test(arg)) {
      out.push('--model', `${arg} ${args[++i] ?? ''}`)
    } else if (/^(--profile=|--local-provider=|--oss$)/.test(arg)) {
      out.push('--model', arg)
    } else if (/^-m./.test(arg)) {
      out.push('--model', arg.slice(arg[2] === '=' ? 3 : 2))
    } else {
      out.push(arg)
    }
  }

  return out
}

// The argument lists of the Codex runs in a command: the ones that spend the plan, not --version, --help or login.
// shortcut: a CLI run is any call with an exec, e or review word, so a flag whose value is one of those counts too, as does any call with a plain word
// whose first word is not a subcommand that runs no model (`find . -name codex -type f`); parse the CLI's options if that bites.
const codexRuns = (command: string) => [
  ...invocations(command, NODE).flatMap(all => {
    // Node's own flags come before the script, some with a value (--require node:fs), so the script is found by name.
    const at = all.findIndex(arg => /codex-companion\.mjs$/i.test(arg))
    // Code given with -e, -p or - (stdin) runs instead of a script, so a companion path after it is only an argument.
    const isCode = all.slice(0, Math.max(at, 0)).some(arg => /^(-e|--eval|-p|--print|-pe|-)(=|$)/.test(arg))
    const args = at < 0 || isCode ? [] : all.slice(at)

    return COMPANION_RUN.test(args[1] ?? '')
      ? [{ args: args.slice(2).filter((_, i, rest) => !COMPANION_VALUE.test(rest[i - 1] ?? '')), takesEffort: !COMPANION_REVIEW.test(args[1] ?? ''), every: false }]
      : []
  }),
  // Which of --model and -c model= the CLI lets win is not ours to guess, so every model it is given must match.
  ...[
    ...invocations(command, CODEX),
    ...[...invocations(command, NPX), ...invocations(command, NPM).filter(all => /^(exec|x|dlx)$/.test(all[0] ?? ''))].flatMap(all => {
      const at = all.findIndex(arg => PACKAGE.test(arg))

      return at < 0 ? [] : [all.slice(at + 1)]
    }),
  ]
    // Help is -h or --help before any --, or help as the first word (codex help exec); a prompt of help is still a run.
    .filter(args => {
      const options = args.includes('--') ? args.slice(0, args.indexOf('--')) : args

      const isRun = args.some(arg => CLI_RUN.test(arg)) || (!CLI_OTHER.test(args[0] ?? '') && args.some(arg => !arg.startsWith('-')))

      return isRun && args[0] !== 'help' && !options.some(arg => /^(-h|--help)$/.test(arg))
    })
    .map(args => ({ args: cliArgs(args), takesEffort: true, every: true })),
]

// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
// shortcut: any other MCP tool that runs a command is not read; deny it by name in managed settings (permissions.deny) or add it here.

// The CLI's own words when a model runs out: "You've hit your Fable limit · resets 4pm (America/Chicago). ... (error type rate_limit,
// HTTP 429 ...)". Other wordings an API error may take are matched loosely beside it.
export const LIMIT = /rate.?limit|usage limit|limit reached|hit your (\w+ )?limit|out of (extra )?usage|usage credits|\b429\b|too many requests/i
const EFFORT = /^(low|medium|high|xhigh|max)$/
// The store key holding { until }: when the pinned model's usage resets, in $.clock.now()'s milliseconds.
const OUT = 'outUntil'
const HOURS = 60 * 60 * 1000

// "resets 4pm (America/Chicago)": the next 4pm on that zone's wall clock, or the local one with no zone.
// shortcut: a date before the time (a weekly reset) is not read, so the next such hour is taken; a model still out then fails one
// subagent and is flagged again.
const clockReset = (text: string, now: number) => {
  const found = /resets (\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([\w/+-]+)\))?/i.exec(text)

  if (!found) {
    return NaN
  }

  const [, hour = '', minute = '0', half = '', timeZone] = found
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(now)
      .map(part => [part.type, Number(part.value)]),
  ) as Record<string, number>
  const day = [parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1] as const
  // The zone's wall clock read as UTC, less the true time, is the zone's offset.
  const offset = Date.UTC(...day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0) - (now - (now % 1000))
  const at = Date.UTC(...day, (Number(hour) % 12) + (half.toLowerCase() === 'pm' ? 12 : 0), Number(minute)) - offset

  return at > now ? at : at + 24 * HOURS
}

// A reset time written in an error: seconds after a | (Claude AI usage limit reached|1700000000), an ISO 8601 timestamp, or a time of day.
const resetIn = (text: string, now: number) => {
  const epoch = /\|\s*(\d{10})\b/.exec(text)
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/.exec(text)

  try {
    return epoch ? Number(epoch[1]) * 1000 : iso ? Date.parse(iso[0]) : clockReset(text, now)
  } catch {
    // An unknown time zone.
    return NaN
  }
}

// The fallback is on only when both models are set.
const settings = async ($: EngineInterface) => ({
  model: (await $.env.get('MODEL_GUARD_SUBAGENT_MODEL'))?.trim(),
  fallback: (await $.env.get('MODEL_GUARD_FALLBACK_MODEL'))?.trim(),
  effort: (await $.env.get('MODEL_GUARD_FALLBACK_EFFORT'))?.trim() ?? '',
})

export const register: Register = on => {
  // Rewrites rather than denies: the subagent starts on the right model, with no retry.
  on('agent.spawn', async ($, e, next) => {
    const model = (await $.env.get('MODEL_GUARD_SUBAGENT_MODEL'))?.trim()

    // A fork always runs on the parent's model, whatever the call says.
    return next(model && e.subagentType !== 'fork' && e.model !== model ? { ...e, model } : e)
  })

  // A session started from this one inherits its model unless the call names another: the name is dropped, as a fork's is ignored.
  on('tool.call', { tool: ['mcp__ccd_session__start_session'] }, async ($, e, next) =>
    next((await $.env.get('MODEL_GUARD_SUBAGENT_MODEL'))?.trim() ? ({ ...e, model: undefined } as typeof e) : e),
  )

  // The subagents whose last request went out on the pinned model: only their errors can mean it ran out.
  const onPinned = new Set<string>()
  // Subagents run side by side: their lookups take turns, so the flag is set, cleared and said once.
  let queue = Promise.resolve()
  const inTurn = <T>(run: () => Promise<T>) => {
    const done = queue.then(run)
    queue = done.then(
      () => undefined,
      () => undefined,
    )

    return done
  }

  // Rewrites the request, not the spawn: every agent type gets the fallback's effort with its prompt, tools and limits untouched, and
  // a subagent already running on the pinned model moves over at its next request. A fork and the main loop run on the session's model.
  on('turn.step', async function* ($, e, next) {
    const route = async () => {
      const { model, fallback, effort } = await settings($)

      if (!model || !fallback || e.agentId === undefined || !e.model.toLowerCase().includes(model.toLowerCase())) {
        return e
      }

      const until = ((await $.store.get(OUT)) as { until?: number } | undefined)?.until

      if (until !== undefined && (await $.clock.now()) < until) {
        return { ...e, model: fallback, effort: EFFORT.test(effort) ? (effort as typeof e.effort) : e.effort }
      }

      if (until !== undefined) {
        await $.store.delete(OUT)
        await $.ui.log(`${$.plugin.name}: subagents are back on ${model}.`)
      }

      onPinned.add(e.agentId)

      return e
    }

    // A failed lookup leaves the request as it was.
    return yield* next(await inTurn(route).catch(() => e))
  })

  // Observes only: the turn ends as it would whatever the lookup does.
  on('turn.complete', async ($, e, next) => {
    const flag = async (agentId: string) => {
      const { model, fallback, effort } = await settings($)
      const now = await $.clock.now()

      if (!model || !fallback || (((await $.store.get(OUT)) as { until?: number } | undefined)?.until ?? 0) > now) {
        return
      }

      // turn.complete carries no error detail: the agent's last message and the account's windows are read for it.
      const messages = await $.session.messages({ agentId }).catch(() => [])
      const last = Array.isArray(messages) ? (messages.filter(one => one.role === 'assistant').at(-1)?.text ?? '') : ''
      const text = `${e.answer} ${last}`
      const windows = await $.session.usage().then(usage => usage.rateLimits, () => [])
      const full = windows.filter(one => one.percentUsed >= 100)
      // A window named for the model (seven_day_fable) before the latest of the full ones.
      const named = windows.find(one => one.kind.toLowerCase().includes(model.toLowerCase()))

      // A full window for the whole account does not make another error a limit: the fallback would be out too.
      if (!LIMIT.test(text) && (named?.percentUsed ?? 0) < 100) {
        return
      }

      // shortcut: with no reset time to read, the model is out for a fixed five hours; read the real one once the error's shape is known.
      const until =
        [resetIn(text, now), Date.parse(named?.resetsAt ?? ''), Math.max(...full.map(one => Date.parse(one.resetsAt ?? '') || 0))].find(at => at > now) ??
        now + 5 * HOURS

      await $.store.set(OUT, { until })
      await $.ui.log(
        `${$.plugin.name}: ${model} is out of usage until ${new Date(until).toISOString()}; subagents run on ${fallback}${EFFORT.test(effort) ? ` at ${effort} effort` : ''} until then.`,
      )
    }

    if (e.reason === 'error' && e.agentId !== undefined && onPinned.has(e.agentId)) {
      const { agentId } = e
      await inTurn(() => flag(agentId)).catch(() => undefined)
    }

    return next(e)
  })

  on('tool.call', { tool: SHELL_TOOLS }, async ($, e, next) => {
    // A Monitor that opens a WebSocket has no command.
    const command = String((e as { command?: unknown }).command ?? '')
    const setting = (await $.env.get('MODEL_GUARD_CODEX_ARGS'))?.trim() ?? ''
    const wanted = required(setting)
    const missing = codexRuns(command).flatMap(({ args, takesEffort, every }) =>
      wanted.filter(one => (takesEffort || one.flag !== '--effort') && !has(args, one, every)),
    )

    // A second Claude started from the shell is a subagent by another door: its --model, and any model its --agents or --settings JSON
    // names, must be the pinned one.
    const model = (await $.env.get('MODEL_GUARD_SUBAGENT_MODEL'))?.trim()
    const other = invocations(command, CLAUDE)
      .flatMap(args => [
        ...args.flatMap((arg, i) => (arg === '--model' ? [args[i + 1]] : arg.startsWith('--model=') ? [arg.slice(8)] : [])),
        // Only in a JSON argument: a prompt may say "model: x".
        ...[...args.filter(arg => arg.startsWith('{')).join(' ').matchAll(/\bmodel\\?["']?\s*:\s*\\?["']?([^\s"'\\,}]+)/g)].map(found => found[1]),
      ])
      .find(one => one !== model)

    if (model && other !== undefined) {
      return { deny: `${$.plugin.name}: a Claude run started here uses ${model}; this one names ${other}. Pass --model ${model} or leave the model out.` }
    }

    if (missing.length > 0) {
      const names = [...new Set(missing.map(({ flag, value }) => (value === undefined ? flag : `${flag} ${value}`)))]

      return { deny: `${$.plugin.name}: every Codex run here takes ${setting}; this one is missing ${names.join(' and ')}. Add it and run again.` }
    }

    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))
}
