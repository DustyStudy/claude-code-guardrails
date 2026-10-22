import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'clean-view',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const ROW = {
  plugin: 'clean-view',
  component: 'ToolUse',
  props: {
    tool_use_id: 't2',
    tool: 'Bash',
    input: { command: 'ls' },
    isRunning: true,
    isErrored: false,
    isInterrupted: false,
  },
} as const

test('the plan shows as a checklist and tool rows are hidden', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  await $.tool.call({
    tool: 'mcp__clean-view__plan',
    tool_use_id: 't1',
    steps: [
      { title: 'Read the code', status: 'completed' },
      { title: 'Write the fix', status: 'in_progress' },
      { title: 42 },
      'junk',
    ],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /^Step 2 of 3$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^Plan$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /● Write the fix/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^Working$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^Next$/ })).toBeDefined()
    await band.unmount()

    const row = await $.ui.mount({ ...ROW, surface })
    expect(await row.findAll({ type: 'Text' })).toHaveLength(0)
    await row.unmount()
  }
})

test('a failed, interrupted or expanded tool row still shows', async ($, on) => {
  on('ui.render', ($$, e) => {
    const { Box, Text } = $$.ui.resolve(e)

    return h(Box, null, h(Text, null, 'row')) as RenderElement
  })

  for (const change of [{ isErrored: true }, { isInterrupted: true }, { isExpanded: true }]) {
    const row = await $.ui.mount({ ...ROW, props: { ...ROW.props, ...change }, surface: 'terminal' })
    expect(await row.find({ type: 'Text', text: /^row$/ })).toBeDefined()
    await row.unmount()
  }
})

const plan = (statuses: readonly string[], title?: string) => ({
  tool: 'mcp__clean-view__plan' as const,
  tool_use_id: 't9',
  title,
  steps: statuses.map((status, i) => ({ title: `Step number ${i + 1}`, status })),
})

test('the step number is the one in work, wherever it sits', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  await $.tool.call(plan(['pending', 'in_progress']))

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /^Step 2 of 2$/ })).toBeDefined()
})

test('with nothing in work, the step number is the first pending one', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  await $.tool.call(plan(['completed', 'pending', 'completed']))

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /^Step 2 of 3$/ })).toBeDefined()
  await band.unmount()

  await $.tool.call(plan(['completed', 'completed']))
  const finished = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await finished.find({ type: 'Text', text: /^Complete$/ })).toBeDefined()
})

test('a long plan shows the steps around the one in work', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  await $.tool.call(plan([...Array(10).fill('completed'), 'in_progress', 'pending']))

  // maxRows 10 leaves room for five steps.
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /● Step number 11/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Step number 1$/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /\+ 7 earlier$/ })).toBeDefined()
})

test('the progress bar fills the width, and a narrow band drops to one line', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  await $.tool.call(plan(['completed', 'in_progress', 'pending']))

  for (const bodyColumns of [40, 80, 144]) {
    const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns }, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /● Step number 2/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: new RegExp(`^━{${Math.round((bodyColumns - 4) / 3)}}$`) })).toBeDefined()
    await band.unmount()
  }

  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 20 }, surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /^● Step number 2$/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /━/ })).toBeUndefined()
})

const TOGGLE = {
  command: 'clean-view',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

const sectionIds = async (compose: (input: typeof COMPOSE) => Promise<{ sections: readonly { id: string }[] }>) =>
  (await compose(COMPOSE)).sections.map(one => one.id)

test('the title is the one the plan gave, and goes when turned off', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  on('command.run', () => ({ text: '' }))
  on('prompt.compose', () => ({ sections: [] }))

  await $.tool.call(plan(['in_progress', 'pending'], 'Build the dashboard'))
  // A later update without a title keeps it.
  await $.tool.call(plan(['completed', 'in_progress']))

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /^Build the dashboard$/ })).toBeDefined()
  await band.unmount()

  await $.command.run(TOGGLE)
  expect(await sectionIds($.prompt.compose)).not.toContain('clean-view:plan')
  await $.command.run(TOGGLE)
  expect(await sectionIds($.prompt.compose)).toContain('clean-view:plan')

  await $.tool.call(plan(['in_progress']))
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /^Plan$/ })).toBeDefined()
})

test('a small row budget keeps the band inside it', async ($, on) => {
  on('ui.render', ($$, e) => h($$.ui.resolve(e).Box, null) as RenderElement)
  await $.tool.call(plan(['completed', 'in_progress', 'pending', 'pending']))

  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 6 }, surface: 'terminal' })
  // Six rows: two borders, heading, progress, one step, the count of the rest.
  expect(await band.findAll({ type: 'Text', text: /Step number/ })).toHaveLength(1)
  expect(await band.find({ type: 'Text', text: /● Step number 2/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /\+ 1 earlier, 2 later$/ })).toBeDefined()
  await band.unmount()

  // Fewer rows than the frame needs: one line.
  const tiny = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 3 }, surface: 'terminal' })
  expect(await tiny.find({ type: 'Text', text: /^● Step number 2$/ })).toBeDefined()
  expect(await tiny.find({ type: 'Text', text: /^Step 2 of 4$/ })).toBeDefined()
})
