import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'aws-context',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('shows the profile and region of the last command, as GovCloud', async ($, on) => {
  mock.env(on, {})
  on('tool.call', { tool: ['Bash'] }, () => ({
    result: { stdout: '', stderr: '', interrupted: false },
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

  await $.tool.call({
    tool: 'Bash',
    command: 'AWS_PROFILE=security aws s3 ls --region us-gov-west-1',
  })

  const band = await (await $.ui.mount(BAND)).find({ type: 'Text' })

  expect(band?.text).toBe('AWS security · us-gov-west-1 · aws-us-gov')
})

test('drops the last region when the profile changes', async ($, on) => {
  mock.env(on, {})
  on('tool.call', { tool: ['Bash'] }, () => ({
    result: { stdout: '', stderr: '', interrupted: false },
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

  await $.tool.call({ tool: 'Bash', command: 'aws s3 ls --profile sandbox --region us-east-1' })
  await $.tool.call({ tool: 'Bash', command: 'aws s3 ls --profile security' })

  const band = await (await $.ui.mount(BAND)).find({ type: 'Text' })

  expect(band?.text).toBe('AWS security · no region set · aws')
})

test('falls back to the environment', async ($, on) => {
  mock.env(on, { AWS_PROFILE: 'AdministratorAccess-111122223333', AWS_REGION: 'us-east-1' })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

  const band = await (await $.ui.mount(BAND)).find({ type: 'Text' })

  expect(band?.text).toBe('AWS AdministratorAccess-111122223333 · us-east-1 · aws')
  expect(band?.props).toMatchObject({ dimColor: true })
})

test('a profile named in AWS_CONTEXT_HIGHLIGHT is highlighted', async ($, on) => {
  mock.env(on, { AWS_PROFILE: 'Admin-444455556666', AWS_REGION: 'us-east-1', AWS_CONTEXT_HIGHLIGHT: 'security, 444455556666' })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

  const band = await (await $.ui.mount(BAND)).find({ type: 'Text' })

  expect(band?.props).toMatchObject({ color: 'warning', bold: true })
})

test('a command that sets two profiles shows the last', async ($, on) => {
  mock.env(on, {})
  on('tool.call', { tool: ['Bash'] }, () => ({
    result: { stdout: '', stderr: '', interrupted: false },
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

  await $.tool.call({ tool: 'Bash', command: 'aws sts get-caller-identity --profile sandbox && aws s3 ls --profile security --region us-gov-east-1' })

  const band = await (await $.ui.mount(BAND)).find({ type: 'Text' })

  expect(band?.text).toBe('AWS security · us-gov-east-1 · aws-us-gov')
})
