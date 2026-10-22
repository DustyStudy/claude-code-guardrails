import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Step } from '../types'

const PLAN_TOOL = 'mcp__clean-view__plan'
const STATUSES = ['pending', 'in_progress', 'completed'] as const
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

    return next(e)
  })

  on('command.run', { command: 'clean-view' }, async $ => {
    const now = !(await read($, isOn))
    await update($, isOn, () => now)

    // Off keeps nothing of the plan.
    if (!now) {
      await update($, steps, () => [])
      await update($, title, () => '')
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

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
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
    const progress = current < 0 ? 'Complete' : `Step ${current + 1} of ${list.length}`

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
}
