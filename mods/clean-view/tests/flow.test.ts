import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'clean-view',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'clean-view',
  component: 'Pane',
  requestId: 'clean-view-agents',
  surface: 'terminal',
  props: { title: '', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('a worker gets the step brief, a pane row, and reports its steps', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('clock.now', () => ({ value: 1000 }))
  let prompt = ''
  on('agent.spawn', (_$, e) => {
    prompt = e.prompt
    return { agentId: 'a1', model: 'claude-opus-5-5' } as never
  })

  await $.agent.spawn({ subagentType: 'clean-view:clean-medium', description: 'Write the parser', prompt: 'Do it.' })
  expect(prompt).toContain('mcp__clean-view__step')
  expect(opened).toEqual(['clean-view-agents'])

  expect(await $.tool.call({ tool: 'mcp__clean-view__step', agentId: 'a1', done: 2, total: 5, note: 'tests' } as never)).toMatchObject({ result: 'ok' })
  // The main session has no row of its own.
  expect(await $.tool.call({ tool: 'mcp__clean-view__step', done: 1 } as never)).toMatchObject({ result: expect.stringMatching(/^ignored/) })

  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /Write the parser/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^2\/5/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /clean-medium · opus 5.5 · tests/ })).toBeDefined()
})

test('other subagents get no brief and do not open the pane', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('clock.now', () => ({ value: 1000 }))
  let prompt = ''
  on('agent.spawn', (_$, e) => {
    prompt = e.prompt
    return { agentId: 'a2', model: 'claude-opus-5-5' } as never
  })

  await $.agent.spawn({ subagentType: 'Explore', description: 'Find callers', prompt: 'Look.' })
  expect(prompt).toBe('Look.')
  expect(opened).toEqual([])
})

test('a subagent cannot replace the plan, and the band shows the phase', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  await $.tool.call({ tool: 'mcp__clean-view__plan', phase: 'delegate', steps: [{ title: 'Write the parser', status: 'in_progress' }] } as never)
  const hijack = await $.tool.call({ tool: 'mcp__clean-view__plan', agentId: 'a1', steps: [{ title: 'Hijacked', status: 'pending' }] } as never)
  expect(hijack).toMatchObject({ result: expect.stringMatching(/^ignored/) })

  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /^Delegate · Step 1 of 1$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Hijacked/ })).toBeUndefined()
})
