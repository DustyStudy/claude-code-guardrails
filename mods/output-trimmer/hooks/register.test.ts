import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { trim } from './register'

const lines = (n: number, at: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => at[i + 1] ?? `line ${i + 1}`).join('\n')

// Answers the command beneath the mod with `stdout`, and records what the mod saved.
const shell = (on: On, stdout: string, write: 'ok' | 'fail' = 'ok', context?: string[]) => {
  const saved: { path: string; text: string }[] = []
  on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false }, ...(context ? { context } : {}) }))
  on('env.get', (_, e) => ({ value: e.name === 'TEMP' ? 'C:\\Temp' : undefined }))
  on('fs.write', (_, e) => {
    if (write === 'fail') {
      throw new Error('disk full')
    }
    saved.push({ path: e.path, text: e.text })

    return { value: undefined }
  })

  return saved
}

test('a short output is kept whole', () => {
  expect(trim(lines(120), 'f.log')).toBeUndefined()
})

test('a long output keeps its head, its error lines and its tail', () => {
  const got = trim(lines(500, { 200: 'Error: AccessDenied on s3:PutObject', 300: 'Warning: deprecated argument' }), 'f.log')!.split('\n')

  expect(got.slice(0, 15)).toEqual(Array.from({ length: 15 }, (_, i) => `line ${i + 1}`))
  expect(got[15]).toBe('[output-trimmer: 445 lines cut, the 2 error or warning lines among them kept below. Full output: f.log]')
  expect(got.slice(16, 18)).toEqual(['Error: AccessDenied on s3:PutObject', 'Warning: deprecated argument'])
  expect(got.at(-1)).toBe('line 500')
  expect(got).toHaveLength(15 + 1 + 2 + 1 + 40)
})

test('error lines past the cap are counted, not kept', () => {
  const at = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [100 + i, `error ${i}`]))
  const got = trim(lines(500, at), 'f.log')!

  expect(got).toContain('error 29')
  expect(got).not.toContain('error 30\n')
  expect(got).toContain('[+ 20 more error or warning lines in the file]')
})

for (const tool of ['Bash', 'PowerShell'] as const) {
  test(`${tool}: a long terraform init is cut, and saved whole first`, async ($, on) => {
    const saved = shell(on, lines(400))
    const got = await $.tool.call({ tool, command: 'cd stack && terraform -chdir=. init -upgrade' })
    const stdout = (got.result as { stdout: string }).stdout

    expect(saved).toHaveLength(1)
    expect(saved[0]!.path).toMatch(/^C:\\Temp\\claude-output\\\d+-.+\.log$/)
    expect(saved[0]!.text).toContain('line 200')
    expect(stdout).not.toContain('line 200\n')
    expect(stdout).toContain(`Full output: ${saved[0]!.path}`)
  })
}

test('a long output of an ordinary command is kept whole', async ($, on) => {
  const saved = shell(on, lines(400))
  const got = await $.tool.call({ tool: 'Bash', command: 'cat big.log' })

  expect(saved).toEqual([])
  expect((got.result as { stdout: string }).stdout).toBe(lines(400))
})

test('when the file cannot be written, nothing is cut', async ($, on) => {
  shell(on, lines(400), 'fail')
  const got = await $.tool.call({ tool: 'Bash', command: 'npm install' })

  expect((got.result as { stdout: string }).stdout).toBe(lines(400))
})

for (const command of ['checkov -d .', 'prowler aws -M json', 'pnpm i', 'uv pip install -r req.txt', 'docker compose up', 'tofu apply tfplan']) {
  test(`counts as noisy: ${command}`, async ($, on) => {
    const saved = shell(on, lines(400))
    await $.tool.call({ tool: 'Bash', command })
    expect(saved).toHaveLength(1)
  })
}

test('a cut result keeps the reminders other hooks gave the model', async ($, on) => {
  shell(on, lines(400), 'ok', ['terraform fmt not run'])
  const got = await $.tool.call({ tool: 'Bash', command: 'terraform init' })

  expect(got.context).toEqual(['terraform fmt not run'])
  expect((got.result as { stdout: string }).stdout).toContain('[output-trimmer:')
})
