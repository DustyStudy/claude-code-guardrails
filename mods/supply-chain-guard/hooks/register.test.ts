import { expect, test } from 'claude-code/testing'

const CASES: readonly (readonly [string, boolean])[] = [
  // Unpinned installs.
  ['pip install requests', false],
  ['pip3 install -r requirements.txt', false],
  ['python -m pip install agent-framework', false],
  ['uv pip install requests', false],
  ['uv add requests', false],
  ['npm install left-pad', false],
  ['npm i -D typescript', false],
  ['npm --prefix web install react', false],
  ['pnpm add zod', false],
  ['yarn add chalk', false],
  ['bash -c "pip install requests"', false],
  ['cd app && npm install lodash', false],
  // Pinned or local installs, and reads.
  ['pip install --require-hashes -r requirements-dev.txt', true],
  ['python -m pip install --require-hashes -r r.txt', true],
  ['pip install -e .', true],
  ['pip install --help', true],
  ['pip list', true],
  ['uv sync', true],
  ['uv pip install --require-hashes -r r.txt', true],
  ['npm ci', true],
  ['npm install', true],
  ['npm run build', true],
  ['pnpm install --frozen-lockfile', true],
  ['yarn install', true],
  ['echo "run: pip install requests"', true],
]

for (const tool of ['Bash', 'PowerShell'] as const) {
  for (const [command, isAllowed] of CASES) {
    test(`${tool} ${isAllowed ? 'runs' : 'is denied'}: ${command}`, async ($, on) => {
      let hasRun = false

      on('tool.call', { tool: [tool] }, () => {
        hasRun = true

        return { result: { stdout: '', stderr: '', interrupted: false } }
      })

      const ran = await $.tool.call({ tool, command })

      expect(hasRun).toBe(isAllowed)
      // A guard that threw also stops the call: that is not the policy denying it.
      expect(/guard failed/.test(JSON.stringify(ran))).toBe(false)
    })
  }
}
