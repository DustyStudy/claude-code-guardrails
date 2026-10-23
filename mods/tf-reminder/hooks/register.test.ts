import { expect, test } from 'claude-code/testing'

// Each step is a .tf path to write, or a command to run; then the status the turn ends on.
const CASES: readonly (readonly [string, readonly string[], string | undefined])[] = [
  ['nothing edited', ['git status'], undefined],
  ['an edit alone', ['main.tf'], 'terraform fmt and validate not run since the last .tf edit'],
  ['an edit then fmt', ['main.tf', 'terraform fmt -recursive'], 'terraform validate not run since the last .tf edit'],
  ['an edit then both', ['main.tf', 'terraform fmt && terraform validate'], undefined],
  // Each folder keeps its own reminder.
  ['a validate aimed at another folder', ['main.tf', 'terraform fmt && terraform -chdir=stack validate'], 'terraform validate not run since the last .tf edit'],
  ['an edit in a stack, both run there by -chdir', ['stack/main.tf', 'terraform -chdir=stack fmt && terraform -chdir=./stack validate'], undefined],
  ['an edit in a stack, both run there after cd', ['stack/main.tf', 'cd stack && terraform fmt && terraform validate'], undefined],
  ['an edit in a stack, both run at the root', ['stack/main.tf', 'terraform fmt; terraform validate'], 'terraform fmt and validate not run since the last .tf edit (in stack)'],
  ['a recursive fmt from the root covers a stack', ['stack/main.tf', 'terraform fmt -recursive'], 'terraform validate not run since the last .tf edit (in stack)'],
  ['an fmt of one file covers its folder', ['stack/main.tf', 'terraform fmt stack/main.tf && echo done'], 'terraform validate not run since the last .tf edit (in stack)'],
  ['find from the root covers a stack', ['stack/main.tf', "find . -name '*.tf' -exec terraform fmt {} \\;"], 'terraform validate not run since the last .tf edit (in stack)'],
  ['an fmt target filled at run time stays in its -chdir folder', ['b/main.tf', 'terraform -chdir=a fmt "$target"'], 'terraform fmt and validate not run since the last .tf edit (in b)'],
  ['two stacks, one done', ['a/main.tf', 'b/main.tf', 'cd a && terraform fmt && terraform validate'], 'terraform fmt and validate not run since the last .tf edit (in b)'],
  ['an edit by absolute path, done by absolute -chdir', ['/repo/net/vpc.tf', 'terraform -chdir=/repo/net fmt && terraform -chdir=/repo/net validate'], undefined],
  ['a Windows path and a Git Bash path to one folder', ['C:\\work\\net\\vpc.tf', 'cd /c/work/net && terraform fmt && terraform validate'], undefined],
  ['both, then another edit', ['main.tf', 'terraform fmt; terraform validate', 'iam.tf'], 'terraform fmt and validate not run since the last .tf edit'],
  ['a failed validate', ['main.tf', 'terraform fmt', 'FAIL terraform validate'], 'terraform validate not run since the last .tf edit'],
  ['prose naming both commands', ['main.tf', 'echo "terraform fmt and terraform validate"'], 'terraform fmt and validate not run since the last .tf edit'],
  ['both behind a profile variable', ['main.tf', 'AWS_PROFILE=security terraform fmt && AWS_PROFILE=security terraform validate'], undefined],
  ['prose with separators inside quotes', ['main.tf', 'echo "example; terraform fmt; terraform validate"'], 'terraform fmt and validate not run since the last .tf edit'],
  ['both through the PowerShell call operator', ['main.tf', '& terraform fmt; & terraform validate'], undefined],
  ['fmt inside a PowerShell script block', ['main.tf', 'Get-ChildItem | ForEach-Object { terraform fmt $_.FullName }'], 'terraform validate not run since the last .tf edit'],
  ['fmt through find and validate through xargs', ['main.tf', "find . -name '*.tf' -exec terraform fmt {} \\;", 'ls | xargs -I{} terraform validate {}'], undefined],
  ['a non-Terraform edit', ['README.md'], undefined],
]

for (const [name, steps, expected] of CASES) {
  test(name, async ($, on) => {
    let status: string | undefined = 'never set'

    on('tool.call', { tool: 'Write' }, () => ({ result: {} as never }))
    on('tool.call', { tool: 'Bash' }, ($, e) => ({
      result: { stdout: '', stderr: '', interrupted: false },
      ...(e.command.startsWith('FAIL') ? { isError: true } : {}),
    }))
    on('ui.status', ($, e) => {
      status = e.text

      return { value: undefined }
    })
    on('turn.complete', () => ({ text: '' }))
    on('session.cwd', () => ({ value: '/repo' }))

    for (const step of steps) {
      await (/\.\w+$/.test(step)
        ? $.tool.call({ tool: 'Write', file_path: step, content: '' })
        : $.tool.call({ tool: 'Bash', command: step }))
    }

    await $.turn.complete({ reason: 'answer', answer: '' } as never)

    expect(status).toBe(expected)
  })
}

test('a cd that moves the session is read from where the command started', async ($, on) => {
  let cwd = '/repo'
  let status: string | undefined = 'never set'

  on('tool.call', { tool: 'Write' }, () => ({ result: {} as never }))
  on('tool.call', { tool: 'Bash' }, () => {
    // The shell keeps the cd: the session ends the command in the stack.
    cwd = '/repo/stack'

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('session.cwd', () => ({ value: cwd }))
  on('ui.status', ($, e) => {
    status = e.text

    return { value: undefined }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Write', file_path: 'stack/main.tf', content: '' })
  await $.tool.call({ tool: 'Bash', command: 'cd stack && terraform fmt && terraform validate' })
  await $.turn.complete({ reason: 'answer', answer: '' } as never)

  expect(status).toBeUndefined()
})
