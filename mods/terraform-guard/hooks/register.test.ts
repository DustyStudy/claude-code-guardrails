import { expect, test } from 'claude-code/testing'

const CASES: readonly (readonly [string, boolean])[] = [
  ['terraform apply -auto-approve', false],
  ['terraform destroy -auto-approve', false],
  ['cd infra && terraform -chdir=stack apply --auto-approve tfplan', false],
  ['AWS_PROFILE=security terraform apply', false],
  ['terraform apply -var-file prod.tfvars', false],
  ['terragrunt run-all apply -auto-approve', false],
  ['terraform plan -out=tfplan', true],
  ['terraform plan -destroy -out=tfplan', true],
  ['terraform apply tfplan', true],
  ['terraform apply -parallelism=1 "gd.tfplan"', true],
  ['terraform fmt -recursive; terraform validate', true],
  ['git status', true],
  ['terraform apply 2>& 1', false],
  ["find . -name '*.tf' -exec terraform apply -auto-approve {} \\;", false],
  ["find . -name '*.tf' -exec terraform fmt {} \\;", true],
  ['ls *.tf | xargs -I{} terraform validate {}', true],
  ['terraform fmt {main,iam}.tf', true],
  ['terraform apply ${PLAN:-tfplan}', true],
  ["$tags = @{ Name = 'x' }; terraform plan -out=tfplan", true],
  ['Get-ChildItem | ForEach-Object { terraform apply -auto-approve }', false],
  ['Get-ChildItem | ForEach-Object {terraform destroy -auto-approve}', false],
  ['terraform apply 2>&1', false],
  ['terraform apply > apply.log', false],
  ['terra\\\nform apply -auto-approve', false],
  ['terraform apply \\\n  -auto-approve tfplan', false],
  ['terraform apply tfplan${SUFFIX} -auto-approve', false],
  ['terraform apply ${PLAN} 2>&1 | tee apply.log', true],
  ['Get-ChildItem | ForEach-Object { terraform fmt $_.FullName }', true],
  ['terraform -chdir=terraform/scanner apply -parallelism=1 tfplan 2>&1 | tee apply.log', true],
  ['(terraform apply -auto-approve)', false],
  ['echo $(terraform apply -auto-approve)', false],
  ['echo "$(terraform destroy -auto-approve)"', false],
  ['echo `terraform apply -auto-approve`', false],
  ['if true; then terraform apply -auto-approve; fi', false],
  ['{ terraform apply -auto-approve; }', false],
  ['! terraform apply -auto-approve', false],
  ['>/dev/null terraform apply -auto-approve', false],
  ['> /dev/null terraform apply -auto-approve', false],
  ['terraform apply "gd;plan.tfplan" -auto-approve', false],
  ['terraform apply tfplan `\n  -auto-approve', false],
  ["Start-Process terraform -ArgumentList 'apply -auto-approve'", false],
  ['Invoke-Expression "terraform apply -auto-approve"', false],
  ['sudo env TF_LOG=1 terraform destroy -auto-approve', false],
  ["$env:AWS_PROFILE='security'; terraform plan -out=tfplan", true],
  ['terraform apply tfplan 2>&1 | tee apply.log', true],
  ['echo "example; terraform apply -auto-approve; example"', true],
  ["bash -c 'echo terraform apply -auto-approve'", true],
  ['terraform destroy -auto-approve=1', false],
  ['terraform apply -auto-approve=TRUE tfplan', false],
  ['terraform apply -auto-approve=false tfplan', true],
  ['& "C:\\Program Files\\Terraform\\terraform.exe" apply -auto-approve', false],
  ['bash -c "terraform apply -auto-approve"', false],
  ['& terraform apply', false],
  ['echo "never run terraform apply -auto-approve"', true],
  ['git commit -m "docs: explain terraform apply"', true],
  ["node task.mjs <<'EOF'\nReview the guard.\nterraform apply -auto-approve is denied.\nEOF", true],
  ["cat > notes.md <<EOF\nterraform apply\nEOF\nterraform destroy -auto-approve", false],
  // A comment is not a plan file, and a full path does not hide a wrapper.
  ['terraform apply # deploy', false],
  ['terraform apply tfplan # reviewed', true],
  ['terraform apply # tfplan\nterraform plan -out=tfplan', false],
  ['/bin/bash -c "terraform apply -auto-approve"', false],
  ['/usr/bin/env TF_LOG=1 terraform destroy -auto-approve', false],
  // apply as another subcommand's value, and help, change nothing.
  ['terraform output apply', true],
  ['terraform state show destroy', true],
  ['terraform apply -help', true],
  ['terraform -chdir=stack apply', false],
  // Flags passed through Terraform's environment, and a script a shell reads from a heredoc.
  ['TF_CLI_ARGS_destroy=-auto-approve terraform destroy', false],
  ["$env:TF_CLI_ARGS_destroy='-auto-approve'; terraform destroy", false],
  ["bash <<'EOF'\nterraform destroy -auto-approve\nEOF", false],
  ['cat <<EOF | sh\nterraform apply -auto-approve\nEOF', false],
  ['"/bin/bash" <<EOF\nterraform destroy -auto-approve\nEOF', false],
  ["cat > install.sh <<'EOF' # bash script\nterraform destroy -auto-approve\nEOF", true],
  ["TF_CLI_ARGS='-auto-approve=false' terraform apply tfplan", true],
]

test('an -auto-approve inherited through TF_CLI_ARGS_destroy is denied', async ($, on) => {
  on('env.get', (_, e) => ({ value: e.name === 'TF_CLI_ARGS_destroy' ? '-auto-approve' : undefined }))
  on('tool.call', { tool: ['Bash'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  expect((await $.tool.call({ tool: 'Bash', command: 'terraform destroy' })).deny).toMatch(/auto-approve is not allowed/)
  // TF_CLI_ARGS_destroy is destroy's alone.
  expect((await $.tool.call({ tool: 'Bash', command: 'terraform apply tfplan' })).deny).toBeUndefined()
})

for (const tool of ['Bash', 'PowerShell'] as const) {
  for (const [command, isAllowed] of CASES) {
    test(`${tool} ${isAllowed ? 'runs' : 'is denied'}: ${command}`, async ($, on) => {
      let hasRun = false

      on('env.get', () => ({ value: undefined }))
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
