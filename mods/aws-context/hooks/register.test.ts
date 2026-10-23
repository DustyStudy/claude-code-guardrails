import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { regionIn } from './register'

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

const CONFIG = [
  '[default]',
  'region = us-east-1',
  '',
  '[profile gov.admin]',
  'sso_region = us-gov-west-1',
  'region = us-gov-west-1',
  '[profile no-region]',
  'output = json',
  '[sso-session corp]',
  'region = eu-west-1',
].join('\r\n')

test('the region of a profile is read from its own config section', () => {
  expect(regionIn(CONFIG, 'gov.admin')).toBe('us-gov-west-1')
  expect(regionIn(CONFIG, 'default')).toBe('us-east-1')
  expect(regionIn(CONFIG, 'no-region')).toBe('')
  expect(regionIn(CONFIG, 'gov')).toBe('')
  expect(regionIn(CONFIG, 'corp')).toBe('')
  expect(regionIn('[profile "gov"]\nregion = us-gov-east-1', 'gov')).toBe('us-gov-east-1')
  expect(regionIn('[profile gov] # production\nregion = us-gov-east-1', 'gov')).toBe('us-gov-east-1')
})

test('a profile with no region in sight takes the one its config sets, as GovCloud', async ($, on) => {
  mock.env(on, { AWS_PROFILE: 'gov.admin', AWS_CONFIG_FILE: '/aws/config' })
  on('fs.read', () => ({ value: CONFIG }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

  const band = await (await $.ui.mount(BAND)).find({ type: 'Text' })

  expect(band?.text).toBe('AWS gov.admin · us-gov-west-1 · aws-us-gov')
  expect(band?.props).toMatchObject({ color: 'warning', bold: true })
})

test('a region given in a command wins over the config file', async ($, on) => {
  mock.env(on, { AWS_CONFIG_FILE: '/aws/config2' })
  on('fs.read', () => ({ value: CONFIG }))
  on('tool.call', { tool: ['Bash'] }, () => ({
    result: { stdout: '', stderr: '', interrupted: false },
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

  await $.tool.call({ tool: 'Bash', command: 'aws s3 ls --profile gov.admin --region us-east-2' })

  const band = await (await $.ui.mount(BAND)).find({ type: 'Text' })

  expect(band?.text).toBe('AWS gov.admin · us-east-2 · aws')
})
