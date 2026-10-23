import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { trim } from './register'

const lines = (n: number, at: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => at[i + 1] ?? `line ${i + 1}`).join('\n')

const DAY = 24 * 60 * 60 * 1000

type Folder = {
  // What the saved-log folder lists besides the logs this test saves.
  logs?: { name: string; kind?: 'file' | 'dir'; size: number; ageDays: number }[]
  // How old the logs this test saves look: a clock moved forward makes them old.
  savedAgeDays?: number
  isLinked?: boolean
  canList?: boolean
  // A log whose cleanup write is refused.
  locked?: string
}

// Answers the command beneath the mod with `stdout`, stands in for the saved-log folder, and records what the mod wrote.
const shell = (on: On, stdout: string, write: 'ok' | 'fail' = 'ok', context?: string[], folder: Folder = {}) => {
  const saved: { path: string; text: string }[] = []
  const name = (path: string) => path.split(/[\\/]/).pop()!
  on('tool.call', () => ({ result: { stdout, stderr: '', interrupted: false }, ...(context ? { context } : {}) }))
  on('env.get', (_, e) => ({ value: e.name === 'TEMP' ? 'C:\\Temp' : undefined }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: folder.isLinked ?? false } }))
  on('fs.list', () => {
    if (folder.canList === false) {
      throw new Error('EACCES')
    }
    const logs = [
      ...(folder.logs ?? []),
      ...saved.map(s => ({ name: name(s.path), kind: 'file' as const, size: s.text.length, ageDays: folder.savedAgeDays ?? 0 })),
    ]

    return {
      value: logs.map(l => ({ name: l.name, kind: l.kind ?? 'file', size: l.size, mtimeMs: Date.now() - l.ageDays * DAY, isLink: false })),
    }
  })
  on('fs.write', (_, e) => {
    if (write === 'fail' || name(e.path) === folder.locked) {
      throw new Error('disk full')
    }
    saved.push({ path: e.path, text: e.text })

    return { value: undefined }
  })

  return saved
}

// The folder part of a written path, as the host resolved it.
const folderOf = (path: string) => path.slice(0, path.length - path.split(/[\\/]/).pop()!.length)

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
    // The host resolves a written path its own way on each platform; the file name is what the two sides share.
    const name = saved[0]!.path.split(/[\\/]/).pop()!
    expect(name).toMatch(/^\d+-.+\.log$/)
    expect(saved[0]!.text).toContain('line 200')
    expect(stdout).not.toContain('line 200\n')
    expect(stdout).toContain(`Full output: C:\\Temp\\claude-output\\${name}]`)
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

test('a save empties saved logs older than a week, and only those', async ($, on) => {
  const saved = shell(on, lines(400), 'ok', undefined, {
    logs: [
      { name: 'old.log', size: 900, ageDays: 8 },
      { name: 'recent.log', size: 900, ageDays: 6 },
      { name: 'emptied.log', size: 0, ageDays: 30 },
      { name: 'notes.txt', size: 900, ageDays: 30 },
      { name: 'sub.log', kind: 'dir', size: 0, ageDays: 30 },
    ],
  })
  await $.tool.call({ tool: 'Bash', command: 'terraform plan' })
  expect(saved).toHaveLength(2)
  // Emptied in the folder the log was saved to, whatever spelling the host gives that folder.
  expect(saved[1]!.path).toBe(`${folderOf(saved[0]!.path)}old.log`)
  expect(saved[1]!.text).toBe('')
})

test('the log just saved is kept even when the clock says it is old', async ($, on) => {
  const saved = shell(on, lines(400), 'ok', undefined, { savedAgeDays: 30 })
  await $.tool.call({ tool: 'Bash', command: 'terraform plan' })
  expect(saved).toHaveLength(1)
  expect(saved[0]!.text).toContain('line 200')
})

test('a linked log folder is not swept', async ($, on) => {
  const saved = shell(on, lines(400), 'ok', undefined, { isLinked: true, logs: [{ name: 'old.log', size: 900, ageDays: 8 }] })
  await $.tool.call({ tool: 'Bash', command: 'terraform plan' })
  expect(saved).toHaveLength(1)
})

test('one log that cannot be emptied does not stop the rest', async ($, on) => {
  const saved = shell(on, lines(400), 'ok', undefined, {
    locked: 'a.log',
    logs: [
      { name: 'a.log', size: 900, ageDays: 8 },
      { name: 'b.log', size: 900, ageDays: 8 },
    ],
  })
  await $.tool.call({ tool: 'Bash', command: 'terraform plan' })
  expect(saved.map(s => s.path.split(/[\\/]/).pop()).slice(1)).toEqual(['b.log'])
})

test('a failed prune still hands back the cut output', async ($, on) => {
  shell(on, lines(400), 'ok', undefined, { canList: false })
  const got = await $.tool.call({ tool: 'Bash', command: 'terraform plan' })
  expect((got.result as { stdout: string }).stdout).toContain('[output-trimmer:')
})
