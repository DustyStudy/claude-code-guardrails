import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const JEV = '& "$HOME\\.claude\\tools\\jev.ps1"'
// Built in two parts, so no secret scanner takes the fixture for a real key.
const FAKE_KEY = `${'AKIA'}ABCDEFGHIJKLMNOP`
const FAKE_PEM = `-----BEGIN RSA ${'PRIVATE'} KEY-----`

const CASES: readonly (readonly [string, boolean])[] = [
  [`${JEV} -Question 'Is this urgent?' -State 'Payouts failing for 3 days'`, true],
  [`${JEV} -Question 'Which area?' -Type choice -Criteria iam,network -Path a.txt,b.txt`, true],
  [`Get-Content findings.jsonl | ${JEV} -Question 'How bad?'`, true],
  [`${JEV} -Question 'Which?' -Path prod.tfvars`, false],
  [`${JEV} -Question 'Which?' -Path terraform.tfvars.json`, false],
  [`${JEV} -Question 'Which?' -Path terraform.tfstate`, false],
  [`${JEV} -Question 'Which?' -Path terraform.tfstate.backup`, false],
  [`${JEV} -Question 'Which?' -Path .env`, false],
  [`${JEV} -Question 'Which?' -Path app\\.env.local`, false],
  [`${JEV} -Question 'Which?' -Path $HOME\\.aws\\credentials`, false],
  [`${JEV} -Question 'Which?' -Path ~/.ssh/id_ed25519`, false],
  [`${JEV} -Question 'Which?' -Path server.pem`, false],
  [`Get-Content prod.tfvars | ${JEV} -Question 'Is this risky?'`, false],
  [`Get-ChildItem *.tfstate | ForEach-Object { ${JEV} -Question 'x' -Path $_.FullName }`, false],
  [`${JEV} -Question 'Leaked?' -State 'key ${FAKE_KEY}'`, false],
  [`${JEV} -Question 'Leaked?' -State '${FAKE_PEM} abc'`, false],
  [`${JEV} -Question 'Which?' -Path C:\\repos\\govcloud-landing-zone\\findings.txt`, false],
  [`${JEV} -Question 'Which region is us-gov-west-1?' -State 'x'`, false],
  [`${JEV} -Question 'Is this CUI?' -State 'x'`, false],
  // Not a Jev call: the guard leaves it alone.
  ['Get-Content prod.tfvars', true],
  ['terraform plan -var-file prod.tfvars -out=tfplan', true],
  // Naming the script is enough to be checked: a false hit only costs a check.
  ['echo "never send .env to jev.ps1"', false],
  // Ways to run it that a parser for calls would miss.
  ['. ./jev.ps1 -Question x -Path prod.tfvars', false],
  ['& "C:/Program Files/PowerShell/7/pwsh.exe" -File ./jev.ps1 -Question x -Path prod.tfvars', false],
  [`${JEV} -Question 'Which?' -Path .aws/credentials`, false],
  [`${JEV} -Question 'Which?' -Path:.env`, false],
  // $env: is PowerShell's environment drive, not a .env file.
  [`$env:TYPESAFE_API_KEY | Out-Null; ${JEV} -Question 'x' -State 'y'`, true],
]

const SAFE_CWD = 'C:\\repos\\wiz-cloud-config-rules'

// Answers the session's own context beneath the guard.
const context = (on: On, cwd: string, region?: string) => {
  on('session.cwd', () => ({ value: cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'AWS_REGION' ? region : undefined }))
}

const run = async ($: Engine, on: On, tool: 'Bash' | 'PowerShell', command: string) => {
  let hasRun = false
  on('tool.call', { tool: [tool] }, () => {
    hasRun = true

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const ran = await $.tool.call({ tool, command })
  // A guard that threw also stops the call: that is not the policy denying it.
  expect(/guard failed/.test(JSON.stringify(ran))).toBe(false)

  return hasRun
}

for (const tool of ['Bash', 'PowerShell'] as const) {
  for (const [command, isAllowed] of CASES) {
    test(`${tool} ${isAllowed ? 'runs' : 'is denied'}: ${command}`, async ($, on) => {
      context(on, SAFE_CWD)
      expect(await run($, on, tool, command)).toBe(isAllowed)
    })
  }
}

test('a Jev call is denied while the session works in a GovCloud region', async ($, on) => {
  context(on, SAFE_CWD, 'us-gov-west-1')
  expect(await run($, on, 'PowerShell', `${JEV} -Question 'x' -State 'y'`)).toBe(false)
})

test('a Jev call is denied from a GovCloud folder', async ($, on) => {
  context(on, 'C:\\repos\\aws-govcloud-baseline')
  expect(await run($, on, 'PowerShell', `${JEV} -Question 'x' -State 'y'`)).toBe(false)
})

test('a Jev call is denied from a folder labelled CUI', async ($, on) => {
  context(on, 'C:\\repos\\CUI_project')
  expect(await run($, on, 'PowerShell', `${JEV} -Question 'x' -State 'y'`)).toBe(false)
})

test('a folder whose name only contains the letters runs', async ($, on) => {
  context(on, 'C:\\repos\\circuit-sim')
  expect(await run($, on, 'PowerShell', `${JEV} -Question 'x' -State 'y'`)).toBe(true)
})

test('the same call runs in a commercial region', async ($, on) => {
  context(on, SAFE_CWD, 'us-east-1')
  expect(await run($, on, 'PowerShell', `${JEV} -Question 'x' -State 'y'`)).toBe(true)
})
