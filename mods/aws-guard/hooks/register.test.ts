import { expect, test } from 'claude-code/testing'

const CASES: readonly (readonly [string, boolean])[] = [
  ['aws iam delete-role --role-name it-admin', false],
  ['aws --profile security iam delete-role-policy --role-name x --policy-name y', false],
  ['aws iam delete-policy-version --policy-arn x --version-id v1', false],
  ['AWS_PROFILE=security aws iam delete-policy --policy-arn x', false],
  ['aws organizations move-account --account-id 1 --source-parent-id r --destination-parent-id ou', false],
  ['aws organizations attach-policy --policy-id p --target-id r', false],
  ['aws kms schedule-key-deletion --key-id abc --pending-window-in-days 7', false],
  ['git status && aws kms schedule-key-deletion --key-id abc', false],
  ['& "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe" iam delete-role --role-name it-admin', false],
  ['/usr/local/bin/aws kms schedule-key-deletion --key-id abc', false],
  ['bash -c "aws iam delete-role --role-name x"', false],
  ['echo "Example: aws iam delete-role --role-name it-admin"', true],
  ["node task.mjs <<'EOF'\naws iam delete-role is denied.\nEOF", true],
  ['(aws iam delete-role --role-name x)', false],
  ['echo "$(aws iam delete-role --role-name x)"', false],
  ['if true; then aws kms schedule-key-deletion --key-id abc; fi', false],
  ['Invoke-Expression "aws organizations leave-organization"', false],
  ["Start-Process aws -ArgumentList 'iam','delete-role','--role-name','x'", false],
  ['echo "example; aws iam delete-role --role-name x; example"', true],
  ["bash -c 'echo aws iam delete-role --role-name x'", true],
  ['aws sso login --sso-session example', true],
  ['aws iam list-roles 2>&1 | grep organizations', true],
  ['aws iam --region us-east-1 delete-role --role-name x', false],
  ['aws --output json --profile security kms --region us-east-1 schedule-key-deletion --key-id abc', false],
  ['Get-ChildItem | ForEach-Object { aws iam delete-role --role-name $_.Name }', false],
  ['aws iam delete-role --role-name x 2>&1', false],
  [`aws iam list-roles --query "Roles[?contains(Description, 'iam delete-role')]"`, true],
  [`aws --profile security iam list-roles --query "Roles[?contains(RoleName, 'delete-role')]"`, true],
  ["aws organizations list-accounts --query 'Accounts[].Id' --output text | xargs -n1 echo", true],
  ['aws organizations help', true],
  ['aws organizations', true],
  ['aws iam list-roles', true],
  ['aws iam get-role --role-name delete-role', true],
  ['aws organizations list-accounts', true],
  ['aws organizations describe-organization', true],
  ['aws kms describe-key --key-id abc', true],
  ['aws s3 ls | grep iam', true],
  ['cd prowler-aws && git log', true],
  // A full path does not hide a wrapper; help and skeletons call nothing.
  ['/usr/bin/env aws iam delete-role --role-name x', false],
  ['/bin/sh -c "aws kms schedule-key-deletion --key-id k"', false],
  ['aws iam delete-role help', true],
  ['aws iam delete-role --generate-cli-skeleton', true],
  ['aws iam delete-role --role-name x # help', false],
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
