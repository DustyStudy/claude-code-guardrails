import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRun, Phase, Step } from '../types'

const PLAN_TOOL = 'mcp__clean-view__plan'
const STEP_TOOL = 'mcp__clean-view__step'
const PANE = 'clean-view-agents'
const STATUSES = ['pending', 'in_progress', 'completed'] as const
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
// The clean-flow workers, as the Agent tool names them with or without the plugin prefix.
const isWorker = (type: string) => /^(clean-view:)?clean-(heavy|careful|medium|light)$/.test(type)
const STEP_BRIEF = `\n\nProgress: right after reading this brief, call ${STEP_TOOL} with your plan's step count as \`total\` and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes.`
const MARK = { pending: '○', in_progress: '●', completed: '✔' }
// Theme keys, so the band follows the person's light or dark theme.
const ACCENT = 'claude'
const DONE = 'success'
const TRACK = 'inactive'
const BORDER = 'promptBorder'
// Below these the band draws one line with no frame.
const MIN_ROWS = 6
const MIN_COLUMNS = 24

const isOn = atom({ plugin: 'clean-view', key: 'isOn' } as const, true)
const steps = atom({ plugin: 'clean-view', key: 'steps' } as const, [])
// The plan's name, as the model gave it.
const title = atom({ plugin: 'clean-view', key: 'title' } as const, '')
const phase = atom({ plugin: 'clean-view', key: 'phase' } as const, '')
const agents = atom({ plugin: 'clean-view', key: 'agents' } as const, [])
// The clock the pane's elapsed times read; ticks only while an agent runs.
const now = atom({ plugin: 'clean-view', key: 'now' } as const, 0)

// shortcut: 1M for every current model, 200k for older ones; extend when a model ships with another window.
const windowOf = (model: string) => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)
const modelName = (id: string) => id.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-\d{8}$/, '')
const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const isStatus = (value: unknown): value is Step['status'] => STATUSES.includes(value as Step['status'])

// The model's input is untrusted: keep only well-formed steps.
const toSteps = (raw: unknown): Step[] =>
  (Array.isArray(raw) ? raw : []).flatMap(one => {
    const title = String(one?.title ?? one?.content ?? '').trim()
    const status = isStatus(one?.status) ? one.status : 'pending'

    return title === '' ? [] : [{ title: title.slice(0, 200), status }]
  })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'clean-view',
      description: 'Toggle Clean View: hide tool calls, show the plan checklist',
    })
    await $.tool.register({
      name: 'plan',
      description:
        'Shows the user a checklist of your plan. Call it with every step before starting multi-step work, and again with the whole list each time a step starts or finishes.',
      inputSchema: {
        type: 'object',
        required: ['steps'],
        properties: {
          title: { type: 'string', description: 'A few words naming the task, such as "Fix the login redirect".' },
          phase: { type: 'string', enum: [...PHASES], description: 'For /clean-view:clean-flow: the flow phase. Left out, the last one stays.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['title', 'status'],
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: [...STATUSES] },
              },
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For clean-flow workers: report progress on your own task to the agents pane. Right after reading the brief, call it with `total` and `done: 0`; call it again as each step finishes.',
      inputSchema: {
        type: 'object',
        required: ['done'],
        properties: {
          done: { type: 'integer', minimum: 0 },
          total: { type: 'integer', minimum: 1 },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
      },
      // Listed up front: workers do not go looking for it behind ToolSearch.
      isDeferred: false,
    })
    await $.command.register({
      name: 'clean-agents',
      description: 'Open the pane of subagents: running and finished, with model, steps, context and time',
    })

    $.clock.every(1000, () => {
      void (async () => {
        if (!(await read($, agents)).some(one => one.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'clean-agents' }, async $ => {
    await update($, now, () => 0)
    await $.ui.open({ id: PANE, title: 'Agents' })

    return { text: 'Agents pane opened.' }
  })

  on('command.run', { command: 'clean-view' }, async $ => {
    const now = !(await read($, isOn))
    await update($, isOn, () => now)

    // Off keeps nothing of the plan.
    if (!now) {
      await update($, steps, () => [])
      await update($, title, () => '')
      await update($, phase, () => '')
    }

    return { text: `Clean View is ${now ? 'on' : 'off'}.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!(await read($, isOn))) {
      return composed
    }

    return {
      sections: [
        ...composed.sections,
        {
          id: 'clean-view:plan',
          scope: 'session',
          text: `The user hides tool calls and follows your work through a checklist. For any task of more than one step, call ${PLAN_TOOL} with a short title and the full list of steps before starting, and call it again with the full list whenever a step becomes in_progress or completed. Keep exactly one step in_progress while working.`,
        },
      ],
    }
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    // The checklist is the main session's: a worker's call would overwrite the orchestrator's plan.
    if (e.agentId) {
      return { result: `ignored: subagents report with ${STEP_TOOL}` }
    }

    if (PHASES.includes(e.phase as Phase)) {
      await update($, phase, () => e.phase as Phase)
    }

    const list = toSteps(e.steps)
    await update($, steps, () => list)
    const name = typeof e.title === 'string' ? e.title.trim().slice(0, 60) : ''

    // A later call without a title keeps the first one's.
    if (name !== '') {
      await update($, title, () => name)
    }

    const done = list.filter(one => one.status === 'completed').length

    return { result: `Checklist shown: ${done} of ${list.length} done.` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names its row.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    if (!e.agentId) {
      return { result: 'ignored: only subagents report steps' }
    }

    const toCount = (value: unknown) => (typeof value === 'number' && value >= 0 ? Math.round(value) : undefined)
    let isMatched = false
    await update($, agents, list =>
      list.map(one => {
        if (one.agentId !== e.agentId) return one
        isMatched = true
        const total = toCount(e.total) ?? one.stepTotal ?? 0
        const done = toCount(e.done) ?? one.stepDone ?? 0
        const note = typeof e.note === 'string' ? e.note.trim().slice(0, 60) : ''

        return { ...one, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: note || undefined }
      }),
    )

    return { result: isMatched ? 'ok' : 'ignored: no pane row for this agent' }
  })

  on('agent.spawn', async ($, e, next) => {
    const isUnbriefed = isWorker(e.subagentType) && !e.prompt.includes(STEP_TOOL)
    const started = await next(isUnbriefed ? { ...e, prompt: e.prompt + STEP_BRIEF } : e)

    // Without an agentId no later event can match the row, which would run forever.
    if (started.deny !== undefined || !started.agentId) {
      return started
    }

    const at = await $.clock.now()
    const run: AgentRun = {
      id: started.agentId,
      agentId: started.agentId,
      type: e.subagentType,
      description: e.description.slice(0, 120),
      model: started.model,
      status: 'running',
      startedAt: at,
      contextTokens: 0,
      contextMax: windowOf(started.model),
    }
    // The cap drops the oldest finished runs only: a running one still reports.
    await update($, agents, list => {
      const kept = [...list.filter(one => one.id !== run.id), run]
      const finished = kept.filter(one => one.status !== 'running')

      return kept.filter(one => one.status === 'running' || finished.indexOf(one) >= finished.length - 50)
    })
    await update($, now, () => at)

    // A flow worker brings the pane up; other subagents wait for /clean-agents.
    if (isWorker(e.subagentType) && (await read($, isOn))) {
      void $.ui.open({ id: PANE, title: 'Agents' })
    }

    return started
  })

  // Each model request of a subagent: its live context fill.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage

    if (e.agentId && usage) {
      const model = usage.model || e.model
      const context =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0) +
        (usage.output_tokens || 0)
      await update($, agents, list =>
        list.map(one =>
          one.agentId !== e.agentId
            ? one
            : {
                ...one,
                model,
                effort: typeof e.effort === 'string' ? e.effort : one.effort,
                contextTokens: context,
                contextMax: windowOf(model),
              },
        ),
      )
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map((one): AgentRun =>
          one.agentId !== e.agentId ? one : { ...one, status: e.reason === 'answer' ? 'done' : 'failed', endedAt: at },
        ),
      )
      await update($, now, () => at)
    }

    return next(e)
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    // A worker's own todos stay out of the orchestrator's checklist.
    if (e.agentId) {
      return next(e)
    }

    const list = toSteps(e.todos)
    await update($, steps, () => list)

    return next(e)
  })

  // A finished plan leaves, with its title, on the next prompt.
  on('prompt.submit', async ($, e, next) => {
    const list = await read($, steps)

    if (list.every(one => one.status === 'completed')) {
      await update($, steps, () => [])
      await update($, title, () => '')
      await update($, phase, () => '')
    }

    return next(e)
  })

  // Tool rows stay hidden unless they failed, or the view asks for everything (ctrl+o, --verbose).
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { isErrored, isInterrupted, isExpanded } = e.props
    const { Box } = $.ui.resolve(e)

    return (await read($, isOn)) && !isErrored && !isInterrupted && !isExpanded ? <Box /> : next(e)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { isErrored, isExpanded } = e.props
    const { Box } = $.ui.resolve(e)

    return (await read($, isOn)) && !isErrored && !isExpanded ? <Box /> : next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const { calls, isExpanded } = e.props
    const { Box } = $.ui.resolve(e)

    return (await read($, isOn)) && !isExpanded && !calls.some(one => one.isErrored || one.isInterrupted) ? <Box /> : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, steps)

    if (e.props.hasSurvey || list.length === 0 || !(await read($, isOn))) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const done = list.filter(one => one.status === 'completed').length
    const upNext = list.findIndex(one => one.status === 'pending')
    const working = list.findIndex(one => one.status === 'in_progress')
    const current = working < 0 ? upNext : working
    const heading = (await read($, title)) || 'Plan'
    const stage = await read($, phase)
    const running = (await read($, agents)).filter(one => one.status === 'running').length
    const progress = [
      stage && stage.charAt(0).toUpperCase() + stage.slice(1),
      current < 0 ? 'Complete' : `Step ${current + 1} of ${list.length}`,
      running > 0 && `${running} agent${running === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' · ')

    // Too little room for the frame: the step in work on one line.
    if (e.props.maxRows < MIN_ROWS || e.props.bodyColumns < MIN_COLUMNS) {
      const step = list[current]

      return (
        <Box flexDirection="column">
          <Box columnGap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text color={step ? ACCENT : DONE}>{step ? MARK[step.status] : MARK.completed}</Text>
                {` ${step?.title ?? heading}`}
              </Text>
            </Box>
            <Text dimColor>{progress}</Text>
          </Box>
          {await next(e)}
        </Box>
      )
    }

    // Room inside the border and its padding.
    const inner = e.props.bodyColumns - 4
    // The band has a row budget: a long plan shows the steps around the one in work.
    // Five rows are the frame's own: two borders, the heading, the progress bar, the count of hidden steps.
    const room = e.props.maxRows - 5
    // With room for more than one, the step before the one in work leads.
    const first = Math.max(
      0,
      Math.min((current < 0 ? list.length : current) - (room > 1 ? 1 : 0), list.length - room),
    )
    const shown = list.length > room ? list.slice(first, first + room) : list
    const hidden = list.length - shown.length
    // A heavy line on a light one, so the filled length still reads where colour is off.
    const filled = Math.round((done / list.length) * inner)

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
          <Box columnGap={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Text bold wrap="truncate-end">{heading}</Text>
            </Box>
            <Text dimColor>{progress}</Text>
          </Box>
          <Text wrap="truncate-end">
            <Text color={current < 0 ? DONE : ACCENT}>{'━'.repeat(filled)}</Text>
            <Text color={TRACK}>{'─'.repeat(inner - filled)}</Text>
          </Text>
          {shown.map((one, at) => {
            const i = first + at
            const label = one.status === 'in_progress' ? 'Working' : i === upNext ? 'Next' : ''

            return (
              <Box columnGap={2}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text
                    wrap="truncate-end"
                    bold={one.status === 'in_progress'}
                    dimColor={one.status !== 'in_progress'}
                  >
                    <Text color={one.status === 'completed' ? DONE : one.status === 'in_progress' ? ACCENT : undefined}>
                      {`${MARK[one.status]} `}
                    </Text>
                    {one.title}
                  </Text>
                </Box>
                {label !== '' && (
                  <Text dimColor={label === 'Next'} color={label === 'Working' ? ACCENT : undefined}>
                    {label}
                  </Text>
                )}
              </Box>
            )
          })}
          {hidden > 0 && (
            <Text dimColor wrap="truncate-end">
              {`  + ${[first > 0 && `${first} earlier`, hidden > first && `${hidden - first} later`].filter(Boolean).join(', ')}`}
            </Text>
          )}
        </Box>
        {await next(e)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const at = await read($, now)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 2) / 2))
    // Running first, then the latest finished.
    const shown = [...list.filter(one => one.status === 'running'), ...list.filter(one => one.status !== 'running').reverse()].slice(0, room)

    return (
      <Box flexDirection="column">
        {shown.length === 0 && <Text dimColor>No subagents yet. /clean-view:clean-flow runs a plan through them.</Text>}
        {shown.map(one => {
          const steps = one.stepTotal ? `${one.stepDone ?? 0}/${one.stepTotal}` : ''
          const context = one.contextTokens ? `ctx ${Math.round((one.contextTokens / one.contextMax) * 100)}%` : ''
          const time = fmtTime((one.endedAt ?? Math.max(at, one.startedAt)) - one.startedAt)
          const mark = one.status === 'running' ? MARK.in_progress : one.status === 'done' ? MARK.completed : '✖'
          const color = one.status === 'running' ? ACCENT : one.status === 'done' ? DONE : 'error'

          return (
            <Box flexDirection="column">
              <Box columnGap={2}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-end" bold={one.status === 'running'}>
                    <Text color={color}>{`${mark} `}</Text>
                    {one.description || one.type}
                  </Text>
                </Box>
                <Text dimColor>{[steps, context, time].filter(Boolean).join('  ')}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {`  ${[one.type.replace(/^clean-view:/, ''), modelName(one.model), one.effort, one.stepNote].filter(Boolean).join(' · ')}`}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
