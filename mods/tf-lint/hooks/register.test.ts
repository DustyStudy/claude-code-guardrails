import { expect, test } from 'claude-code/testing'

const SSH_OPEN = `resource "aws_security_group" "bastion" {
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}`
const RANGE_OPEN = `resource "aws_vpc_security_group_ingress_rule" "all" {
  from_port = 0
  to_port   = 65535
  cidr_ipv4 = "0.0.0.0/0"
}`
const CLEAN = `# was arn:aws:iam::123456789012:role/old
resource "aws_security_group" "web" {
  ingress {
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 22
    to_port     = 22
    cidr_blocks = ["10.0.0.0/8"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
locals {
  role = "arn:\${data.aws_partition.current.partition}:iam::\${var.account_id}:role/x"
}`

// What the model reads after the write, or undefined when the write was denied.
const FLAGS: readonly (readonly [string, string, string, RegExp | null | undefined])[] = [
  ['an ARN with a hardcoded partition', 'main.tf', 'role = "arn:aws:iam::1:role/x"', /partition/],
  ['a GovCloud ARN, hardcoded too', 'main.tf', 'role = "arn:aws-us-gov:iam::1:role/x"', /partition/],
  ['SSH open to the world', 'sg.tf', SSH_OPEN, /port 22 /],
  ['a port range covering SSH and RDP', 'sg.tf', RANGE_OPEN, /port 22 and 3389/],
  ['all-protocol ingress', 'sg.tf', 'ingress {\n  from_port = 0\n  to_port = 0\n  protocol = "-1"\n  cidr_blocks = ["0.0.0.0/0"]\n}', /port 22 and 3389/],
  ['an all-protocol ingress rule resource', 'sg.tf', 'resource "aws_vpc_security_group_ingress_rule" "all" {\n  ip_protocol = "-1"\n  cidr_ipv6 = "::/0"\n}', /port 22 and 3389/],
  ['all-protocol named only in a trailing comment', 'sg.tf', 'ingress {\n  protocol = "tcp" # protocol = "-1"\n  from_port = 443\n  to_port = 443\n  cidr_blocks = ["0.0.0.0/0"]\n}', null],
  ['clean Terraform', 'sg.tf', CLEAN, null],
  ['a KMS key with neither setting', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  description = "logs"\n  tags = {\n    team = "sec"\n  }\n}', /enable_key_rotation = true; and .*deletion_window_in_days of 7 to 30/],
  ['a KMS key whose rotation sits only in a nested block', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  deletion_window_in_days = 30\n  dynamic "x" {\n    content {\n      enable_key_rotation = true\n    }\n  }\n}', /enable_key_rotation/],
  ['a KMS key with a 3-day window', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  enable_key_rotation     = true\n  deletion_window_in_days = 3\n}', /7 to 30/],
  ['a compliant KMS key', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  enable_key_rotation     = true\n  deletion_window_in_days = 30\n  tags = { team = "sec" }\n}', null],
  ['a KMS key whose window comes from a variable', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  enable_key_rotation     = true\n  deletion_window_in_days = var.window\n}', null],
  ['an asymmetric signing key, which cannot rotate', 'kms.tf', 'resource "aws_kms_key" "sign" {\n  customer_master_key_spec = "RSA_2048"\n  key_usage = "SIGN_VERIFY"\n  deletion_window_in_days = 7\n}', null],
  ['an edit inside a KMS key, its header out of sight', 'kms.tf', '  deletion_window_in_days = 30\n}', null],
  ['a GovCloud provider without FIPS', 'providers.tf', 'provider "aws" {\n  region = "us-gov-west-1"\n  assume_role {\n    role_arn = "arn:${data.aws_partition.current.partition}:iam::1:role/x"\n  }\n}', /use_fips_endpoint = true/],
  ['a GovCloud provider with FIPS', 'providers.tf', 'provider "aws" {\n  alias = "east"\n  region = "us-gov-east-1"\n  use_fips_endpoint = true\n}', null],
  ['a commercial provider', 'providers.tf', 'provider "aws" {\n  region = "us-east-1"\n}', null],
  ['an ARN outside Terraform', 'README.md', 'arn:aws:iam::1:role/x', null],
  ['a live access key, in any file', 'notes.md', `key ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`, undefined],
  ["AWS's sample access key", 'notes.md', 'key AKIAIOSFODNN7EXAMPLE', null],
  // Built in parts, so no secret scanner takes the fixtures for real ones.
  ['a private key', 'deploy/key.txt', `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nabc`, undefined],
  ['a GitHub token', '.github/notes.md', `token ${'ghp'}_${'a'.repeat(36)}`, undefined],
  ['a Slack token', 'config.yml', `slack: ${'xoxb'}-1234567890-abcdef`, undefined],
  ['an ssh-ed25519 public line', 'id_ed25519.pub', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 me@host', null],
  ['an unquoted secret key in a .env file', '.env', `AWS_SECRET_ACCESS_${'KEY'}=${'wJalrXUtnFEMIK7MDENGbPxRfiCY'}abcdefghijkl`, undefined],
  ["AWS's sample secret key, unquoted", '.env', `AWS_SECRET_ACCESS_${'KEY'}=wJalrXUtnFEMI/K7MDENG/${'bPxRfiCY'}EXAMPLEKEY`, null],
]

test('a notebook cell with a token is denied', async ($, on) => {
  let hasRun = false
  on('tool.call', { tool: ['NotebookEdit'] }, () => {
    hasRun = true

    return { result: {} as never }
  })
  const ran = await $.tool.call({ tool: 'NotebookEdit', notebook_path: 'a.ipynb', new_source: `t = "${'ghp'}_${'b'.repeat(36)}"` })

  expect(hasRun).toBe(false)
  expect(ran.deny).toMatch(/private key or API token into a\.ipynb/)
})

for (const tool of ['Write', 'Edit'] as const) {
  for (const [name, file_path, text, expected] of FLAGS) {
    test(`${tool} of ${name}`, async ($, on) => {
      let hasRun = false

      on('tool.call', { tool: [tool] }, () => {
        hasRun = true

        return { result: {} as never }
      })

      const call =
        tool === 'Write'
          ? { tool, file_path, content: text }
          : { tool, file_path, old_string: 'x', new_string: text }
      const ran = await $.tool.call(call)
      const context = (ran.context ?? []).join('\n')

      expect(hasRun).toBe(expected !== undefined)

      if (expected === null) {
        expect(context).toBe('')
      } else if (expected !== undefined) {
        expect(context).toMatch(expected)
      }
    })
  }
}
