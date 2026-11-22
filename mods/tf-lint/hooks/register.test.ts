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
// A GitHub OIDC role trust in each of its three forms: a jsonencode map, heredoc JSON, and aws_iam_policy_document blocks.
const GH = 'token.actions.githubusercontent.com'
const AUD = `        StringEquals = { "${GH}:aud" = "sts.amazonaws.com" }`
const SUB = (value: string) => `        StringLike = { "${GH}:sub" = ${value} }`
const ROLE = (conditions: string) =>
  `resource "aws_iam_role" "deploy" {\n  assume_role_policy = jsonencode({\n    Statement = [{\n      Action    = "sts:AssumeRoleWithWebIdentity"\n      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }\n      Condition = {\n${conditions}\n      }\n    }]\n  })\n}`
const HEREDOC = (sub: string) =>
  `resource "aws_iam_role" "ci" {\n  assume_role_policy = <<EOF\n{\n  "Statement": [{\n    "Effect": "Allow",\n    "Principal": { "Federated": "arn:\${data.aws_partition.current.partition}:iam::1:oidc-provider/${GH}" },\n    "Action": "sts:AssumeRoleWithWebIdentity",\n    "Condition": {\n      "StringEquals": { "${GH}:aud": "sts.amazonaws.com" },\n      "StringLike": { "${GH}:sub": [${sub}] }\n    }\n  }]\n}\nEOF\n}`
const DOCUMENT = (sub: string) =>
  `data "aws_iam_policy_document" "trust" {\n  statement {\n    actions = ["sts:AssumeRoleWithWebIdentity"]\n    principals {\n      type        = "Federated"\n      identifiers = [aws_iam_openid_connect_provider.github.arn]\n    }\n    condition {\n      test     = "StringEquals"\n      variable = "${GH}:aud"\n      values   = ["sts.amazonaws.com"]\n    }\n    condition {\n      values   = [${sub}]\n      test     = "StringLike"\n      variable = "${GH}:sub"\n    }\n  }\n}`
const STATIC_KEYS =
  'jobs:\n  deploy:\n    steps:\n      - uses: aws-actions/configure-aws-credentials@v4\n        with:\n          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}\n          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}\n          aws-region: us-gov-west-1'
const OIDC_WORKFLOW =
  'permissions:\n  id-token: write\n  contents: read\njobs:\n  deploy:\n    steps:\n      # aws-access-key-id: ${{ secrets.OLD_KEY }}\n      - uses: aws-actions/configure-aws-credentials@v4\n        with:\n          role-to-assume: arn:aws-us-gov:iam::1:role/deploy\n          aws-region: us-gov-west-1'

// Built in parts, so no secret scanner takes the fixtures for real ones.
const KEY = `${'AKIA'}${'ABCDEFGHIJKLMNOP'}`
const TOKEN = `${'ghp'}_${'c'.repeat(36)}`
const K = `${'wJalrXUtnFEMIK7MDENGbPxRfiCY'}abcdefghijkl`
const EKS = 'oidc.eks.us-east-1.amazonaws.com/id/ABC'
const BY_REFERENCE = (conditions: string) => ROLE(conditions).replace('.github.', '.this.')
const KEY_OUTPUTS =
  'outputs:\n  aws-access-key-id:\n    description: The temporary key id\n    value: ${{ steps.assume.outputs.aws-access-key-id }}\n  aws-secret-access-key:\n    value: ${{ steps.assume.outputs.aws-secret-access-key }}\nruns:\n  using: composite\n  steps:\n    - id: assume\n      uses: aws-actions/configure-aws-credentials@v4\n      with:\n        role-to-assume: ${{ inputs.role }}\n        output-credentials: true'
const SSH_RULE = (type: string, name: string) =>
  `resource "aws_vpc_security_group_${type}_rule" "${name}" {\n  from_port = 22\n  to_port = 22\n  ip_protocol = "tcp"\n  cidr_ipv4 = "0.0.0.0/0"\n}`

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
  ['an ingress rule resource with tags', 'sg.tf', 'resource "aws_vpc_security_group_ingress_rule" "ssh" {\n  from_port = 22\n  to_port = 22\n  cidr_ipv4 = "0.0.0.0/0"\n  tags = { Name = "ssh" }\n}', /port 22 /],
  ['a KMS key with neither setting', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  description = "logs"\n  tags = {\n    team = "sec"\n  }\n}', /enable_key_rotation = true; and .*deletion_window_in_days of 7 to 30/],
  ['a KMS key whose rotation sits only in a nested block', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  deletion_window_in_days = 30\n  dynamic "x" {\n    content {\n      enable_key_rotation = true\n    }\n  }\n}', /enable_key_rotation/],
  ['a compliant KMS key with a brace in its description', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  description = "closing } brace"\n  enable_key_rotation     = true\n  deletion_window_in_days = 30\n}', null],
  ['a KMS key whose only window sits in its tags', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  enable_key_rotation = true\n  tags = { note = "{}", deletion_window_in_days = 30 }\n}', /7 to 30/],
  ['a KMS key with a quoted 3-day window', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  enable_key_rotation     = true\n  deletion_window_in_days = "3"\n}', /7 to 30/],
  ['a KMS key with a negative window', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  enable_key_rotation     = true\n  deletion_window_in_days = -1\n}', /7 to 30/],
  ['a KMS key with a 3-day window','kms.tf', 'resource "aws_kms_key" "logs" {\n  enable_key_rotation     = true\n  deletion_window_in_days = 3\n}', /7 to 30/],
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
  ['a PGP private key block', 'backup.asc', `-----BEGIN PGP ${'PRIVATE'} KEY BLOCK-----\nabc`, undefined],
  ['an encrypted private key', 'k.txt', `-----BEGIN ENCRYPTED ${'PRIVATE'} KEY-----\nabc`, undefined],
  ['a fine-grained GitHub token', 'notes.md', `${'github'}_pat_${'A1b2'.repeat(20)}`, undefined],
  ['a GitLab token', '.gitlab-ci.yml', `TOKEN: ${'glpat'}-${'aB3_'.repeat(5)}`, undefined],
  ['an npm token', 'ci.yml', `NPM_TOKEN: ${'npm'}_${'aB3d'.repeat(9)}`, undefined],
  ['a Slack app token', 'config.yml', `slack: ${'xoxs'}-1234567890-abcdef`, undefined],
  ['a Slack app-level token', 'config.yml', `slack: ${'xapp'}-1-A0AB12CD3-1234567890-abcdef`, undefined],
  ['a Slack webhook', 'alerts.tf', `url = "https://${'hooks.slack'}.com/services/T0AB12CD3/B0AB12CD3/${'aB3d'.repeat(6)}"`, undefined],
  ['an Anthropic key', 'app.py', `key = "${'sk-ant'}-api03-${'aB3d'.repeat(6)}"`, undefined],
  ['an OpenAI project key', 'app.py', `key = "${'sk-proj'}-${'aB3d'.repeat(6)}"`, undefined],
  ['an older OpenAI key', 'app.py', `key = "${'sk'}-${'aB3d'.repeat(12)}"`, undefined],
  ['a Stripe live key', 'pay.ts', `const key = '${'sk_live'}_${'aB3d'.repeat(6)}'`, undefined],
  ['a Stripe restricted live key', 'pay.ts', `const key = '${'rk_live'}_${'aB3d'.repeat(6)}'`, undefined],
  ['a Google API key', 'maps.js', `key=${'AIza'}${'aB3d_-x'.repeat(5)}`, undefined],
  ['an Azure storage key', 'main.tf', `conn = "DefaultEndpointsProtocol=https;AccountName=x;${'AccountKey'}=${'aB3+/'.repeat(17)}a==;"`, undefined],
  ['a Supabase token', 'env.ts', `${'sbp'}_${'a1b2c3d4'.repeat(5)}`, undefined],
  ['a Supabase secret key', 'env.ts', `${'sb_secret'}_${'aB3d'.repeat(6)}`, undefined],
  // What looks close and is not a secret.
  ['a Stripe test key', 'pay.test.ts', `const key = 'sk_test_${'aB3d'.repeat(6)}'`, null],
  ['a CSS class that starts sk-', 'spinner.css', '.sk-fading-circle-container-animation { color: red }', null],
  ['an Anthropic key placeholder', 'README.md', 'ANTHROPIC_API_KEY=sk-ant-api03-EXAMPLEEXAMPLEEXAMPLE', null],
  ['a key named by its variable', 'main.tf', 'api_key = var.openai_api_key # sk-...', null],
  ['a Slack webhook placeholder', 'README.md', 'https://hooks.slack.com/services/T000/B000/XXXX', null],
  ['a PGP public key block', 'key.asc', '-----BEGIN PGP PUBLIC KEY BLOCK-----\nabc', null],
  ['a JWT in a fixture', 'auth.test.ts', 'const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlc2lnbmF0dXJl"', null],
  ['an Azure connection string that uses a variable', 'main.tf', 'conn = "AccountName=x;AccountKey=${var.key};"', null],
  ['an ssh-ed25519 public line', 'id_ed25519.pub', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 me@host', null],
  ['an unquoted secret key in a .env file', '.env', `AWS_SECRET_ACCESS_${'KEY'}=${'wJalrXUtnFEMIK7MDENGbPxRfiCY'}abcdefghijkl`, undefined],
  ["AWS's sample secret key, unquoted", '.env', `AWS_SECRET_ACCESS_${'KEY'}=wJalrXUtnFEMI/K7MDENG/${'bPxRfiCY'}EXAMPLEKEY`, null],
  // Found in red-team review.
  ['a provider secret_key', 'providers.tf', `provider "aws" {\n  secret_${'key'} = "${'wJalrXUtnFEMIK7MDENGbPxRfiCY'}abcdefghijkl"\n}`, undefined],
  ['a secret key in STS JSON', 'creds.json', `{ "SecretAccess${'Key'}": "${'wJalrXUtnFEMIK7MDENGbPxRfiCY'}abcdefghijkl" }`, undefined],
  ['a provider secret_key from a variable', 'providers.tf', 'provider "aws" {\n  region = "us-east-1"\n  secret_key = var.secret_key\n}', null],
  ['an SSH rule resource with a lifecycle block', 'sg.tf', 'resource "aws_security_group_rule" "ssh" {\n  type = "ingress"\n  from_port = 22\n  to_port = 22\n  cidr_blocks = ["0.0.0.0/0"]\n  lifecycle {\n    create_before_destroy = true\n  }\n}', /port 22 /],
  ['an egress rule resource with a lifecycle block', 'sg.tf', 'resource "aws_security_group_rule" "out" {\n  type = "egress"\n  from_port = 0\n  to_port = 65535\n  cidr_blocks = ["0.0.0.0/0"]\n  lifecycle {\n    create_before_destroy = true\n  }\n}', null],
  ['clean Terraform with a lifecycle block', 'sg.tf', CLEAN.replace('  egress {', '  lifecycle {\n    create_before_destroy = true\n  }\n  egress {'), null],
  ['a KMS key with unquoted labels', 'kms.tf', 'resource aws_kms_key logs {\n  description = "logs"\n}', /enable_key_rotation = true; and .*7 to 30/],
  ['a GovCloud provider with an unquoted label', 'providers.tf', 'provider aws {\n  region = "us-gov-west-1"\n}', /use_fips_endpoint = true/],
  ['a KMS key whose rotation sits in a block comment', 'kms.tf', 'resource "aws_kms_key" "logs" {\n  /* enable_key_rotation = true */\n  deletion_window_in_days = 30\n}', /enable_key_rotation/],
  ['a wildcard ARN path before a cron step', 'iam.tf', 'locals {\n  path = "bucket/*"\n  from_port = 22\n  to_port = 22\n  cidr = "0.0.0.0/0"\n  cron = "cron(0 */2 * * ? *)"\n}', /port 22 /],
  ['an ARN in an OpenTofu file', 'main.tofu', 'role = "arn:aws:iam::1:role/x"', /partition/],
  ['an ARN in an isolated partition', 'main.tf', 'role = "arn:aws-iso-b:iam::1:role/x"', /partition/],
  // Static IAM credentials.
  ['an IAM access key', 'iam.tf', 'resource "aws_iam_access_key" "ci" {\n  user = aws_iam_user.ci.name\n}', /static IAM access key/],
  ['an IAM access key with unquoted labels', 'iam.tf', 'resource aws_iam_access_key ci {\n  user = "ci"\n}', /static IAM access key/],
  ['an IAM access key in .tf.json', 'iam.tf.json', '{ "resource": { "aws_iam_access_key": { "ci": { "user": "ci" } } } }', /static IAM access key/],
  ['an IAM console password', 'iam.tf', 'resource "aws_iam_user_login_profile" "me" {\n  user = aws_iam_user.me.name\n}', /console password/],
  ['an IAM user without keys', 'iam.tf', 'resource "aws_iam_user" "ci" {\n  name = "ci"\n}', null],
  // Long-lived keys in other clouds.
  ['a Google service account key', 'gcp.tf', 'resource "google_service_account_key" "ci" {\n  service_account_id = google_service_account.ci.name\n}', /long-lived Google service account key \(google_service_account_key\); use workload identity federation/],
  ['a Google service account key in .tf.json', 'gcp.tf.json', '{ "resource": { "google_service_account_key": { "ci": { "service_account_id": "ci" } } } }', /long-lived Google service account key/],
  ['an Azure application password', 'azure.tf', 'resource "azuread_application_password" "ci" {\n  application_id = azuread_application.ci.id\n}', /long-lived Azure application client secret \(azuread_application_password\); use a federated identity credential/],
  ['an Azure service principal password, unquoted', 'azure.tf', 'resource azuread_service_principal_password ci {\n  service_principal_id = azuread_service_principal.ci.id\n}', /long-lived Azure service principal secret \(azuread_service_principal_password\); use a federated identity credential/],
  ['a Google service account and its IAM member', 'gcp.tf', 'resource "google_service_account" "ci" {\n  account_id = "ci"\n}\nresource "google_service_account_iam_member" "wif" {\n  role = "roles/iam.workloadIdentityUser"\n}', null],
  ['a longer type name than the key', 'gcp.tf', 'resource "google_service_account_key_rotation" "ci" {\n  name = "ci"\n}', null],
  ['an Azure federated identity credential', 'azure.tf', 'resource "azuread_application_federated_identity_credential" "ci" {\n  issuer = "https://token.actions.githubusercontent.com"\n}', null],
  // Over-broad actions.
  ['a jsonencode policy granting every action', 'iam.tf', 'policy = jsonencode({\n  Statement = [{\n    Effect   = "Allow"\n    Action   = "*"\n    Resource = "*"\n  }]\n})', /grants every action \(Action "\*"\) in a policy; name the actions the identity needs/],
  ['a JSON policy with * in its action list', 'iam.tf', 'policy = <<EOF\n{ "Statement": [{ "Effect": "Allow", "Action": ["s3:GetObject", "*"], "Resource": "*" }] }\nEOF', /grants every action/],
  ['a JSON policy with a bare * action', 'iam.tf', 'policy = <<EOF\n{ "Statement": [{ "Effect": "Allow", "Action": "*", "Resource": "*" }] }\nEOF', /grants every action/],
  ['a policy document granting every action', 'iam.tf', 'data "aws_iam_policy_document" "d" {\n  statement {\n    actions   = ["*"]\n    resources = ["*"]\n  }\n}', /grants every action/],
  ['an HCL action of *', 'iam.tf', 'statement {\n  action = "*"\n}', /grants every action/],
  ['a policy granting all IAM actions', 'iam.tf', 'policy = jsonencode({\n  Statement = [{\n    Effect   = "Allow"\n    Action   = ["s3:GetObject", "iam:*"]\n    Resource = "*"\n  }]\n})', /grants all IAM or STS actions \(iam:\* or sts:\*\); name the actions it needs/],
  ['a policy document granting all STS actions', 'iam.tf', 'data "aws_iam_policy_document" "d" {\n  statement {\n    actions = ["sts:*"]\n  }\n}', /grants all IAM or STS actions/],
  ['an escaped JSON policy in .tf.json granting every action', 'iam.tf.json', '{"policy":"{\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Action\\":\\"*\\",\\"Resource\\":\\"*\\"}]}"}', /grants every action/],
  ['an escaped JSON policy with one action and a * resource', 'iam.tf.json', '{"policy":"{\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Action\\":\\"s3:GetObject\\",\\"Resource\\":\\"*\\"}]}"}', null],
  ['an action list with all of IAM, then *', 'iam.tf', 'data "aws_iam_policy_document" "d" {\n  statement {\n    actions = ["iam:*", "*"]\n  }\n}', /grants every action .*; and grants all IAM or STS actions/],
  ['specific actions on every resource', 'iam.tf', 'policy = jsonencode({\n  Statement = [{\n    Effect   = "Allow"\n    Action   = ["s3:GetObject", "s3:List*"]\n    Resource = "*"\n  }]\n})', null],
  ['one action and a * resource on one line', 'iam.tf', 'policy = <<EOF\n{ "Statement": [{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }] }\nEOF', null],
  ['an action list and a * resource list on one line', 'iam.tf', 'policy = <<EOF\n{ "Statement": [{ "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": ["*"] }] }\nEOF', null],
  ['a KMS key-admin statement', 'kms.tf', 'policy = <<EOF\n{ "Statement": [{ "Effect": "Allow", "Principal": { "AWS": "${local.root}" }, "Action": "kms:*", "Resource": "*" }] }\nEOF', null],
  ['a deny of everything but IAM and STS', 'scp.tf', 'data "aws_iam_policy_document" "d" {\n  statement {\n    effect      = "Deny"\n    not_actions = ["iam:*", "sts:*"]\n    resources   = ["*"]\n  }\n}\nlocals {\n  p = jsonencode({ Effect = "Deny", NotAction = ["iam:*"], Resource = "*" })\n}', null],
  // GitHub OIDC trust.
  ['a GitHub OIDC trust pinned to a branch', 'role.tf', ROLE(`${AUD}\n${SUB('"repo:acme/infra:ref:refs/heads/main"')}`), null],
  ['a GitHub OIDC trust for any repo in an org', 'role.tf', ROLE(`${AUD}\n${SUB('"repo:acme/*"')}`), /wildcard repository \(repo:acme\/\*\)/],
  ['a GitHub OIDC trust listing repo:*', 'role.tf', ROLE(`${AUD}\n${SUB('["repo:acme/infra:*", "repo:*"]')}`), /wildcard repository \(repo:\*\)/],
  ['a GitHub OIDC trust for a bare *', 'role.tf', ROLE(`${AUD}\n${SUB('"*"')}`), /wildcard repository \(\*\)/],
  ['a GitHub OIDC trust without sub', 'role.tf', ROLE(AUD), /without a :sub condition/],
  ['a GitHub OIDC trust without aud', 'role.tf', ROLE(SUB('"repo:acme/infra:*"')), /without a :aud condition/],
  ['a GitHub OIDC trust with an interpolated repo', 'role.tf', ROLE(`${AUD}\n${SUB('"repo:${var.org}/${var.repo}:*"')}`), null],
  ['a GitHub OIDC trust with an interpolated org and a wildcard repo', 'role.tf', ROLE(`${AUD}\n${SUB('"repo:${var.org}/*"')}`), /wildcard repository/],
  ['a GitHub OIDC trust in heredoc JSON', 'role.tf', HEREDOC('"repo:acme/infra:environment:prod"'), null],
  ['a wildcard GitHub OIDC trust in heredoc JSON', 'role.tf', HEREDOC('"repo:acme/*"'), /wildcard repository/],
  ['a GitHub OIDC trust in a policy document', 'role.tf', DOCUMENT('"repo:acme/infra:ref:refs/heads/main"'), null],
  ['a wildcard GitHub OIDC trust in a policy document', 'role.tf', DOCUMENT('"repo:acme/*"'), /wildcard repository/],
  ['a GitHub OIDC trust with no condition, its provider by reference', 'role.tf', ROLE(''), /without a :sub condition.*without a :aud condition/],
  ['an EKS OIDC trust by reference with no condition', 'role.tf', ROLE('').replace('.github.', '.eks.'), /trusts an OIDC provider without a :sub condition.*trusts an OIDC provider without a :aud condition/],
  ['the GitHub OIDC provider', 'oidc.tf', `resource "aws_iam_openid_connect_provider" "github" {\n  url            = "https://${GH}"\n  client_id_list = ["sts.amazonaws.com"]\n}`, null],
  // Wildcard principals.
  ['a bucket policy open to everyone', 'bucket.tf', 'policy = jsonencode({\n  Statement = [{\n    Effect    = "Allow"\n    Principal = "*"\n    Action    = "s3:GetObject"\n    Resource  = "*"\n  }]\n})', /Principal "\*" with no condition/],
  ['an AWS "*" principal list in JSON', 'bucket.tf', 'policy = <<EOF\n{ "Statement": [{ "Effect": "Allow", "Principal": { "AWS": ["*"] }, "Action": "sqs:SendMessage" }] }\nEOF', /Principal "\*"/],
  ['a policy document open to everyone', 'bucket.tf', 'data "aws_iam_policy_document" "p" {\n  statement {\n    actions = ["s3:GetObject"]\n    principals {\n      type        = "AWS"\n      identifiers = ["*"]\n    }\n  }\n}', /Principal "\*"/],
  ['a TLS-only deny to everyone', 'bucket.tf', 'policy = jsonencode({\n  Statement = [{\n    Effect    = "Deny"\n    Principal = "*"\n    Action    = "s3:*"\n    Resource  = "*"\n    Condition = { Bool = { "aws:SecureTransport" = "false" } }\n  }]\n})', null],
  ['a wildcard resource and action, no principal', 'iam.tf', 'policy = <<EOF\n{ "Statement": [{ "Effect": "Allow", "Action": "s3:ListAllMyBuckets", "Resource": "*" }] }\nEOF\ndata "aws_iam_policy_document" "d" {\n  statement {\n    actions   = ["s3:*"]\n    resources = ["*"]\n  }\n}', null],
  // Secret variables and outputs.
  ['a password variable without sensitive', 'variables.tf', 'variable "db_password" {\n  type = string\n}', /variable "db_password" without sensitive = true/],
  ['a sensitive password variable', 'variables.tf', 'variable "db_password" {\n  type      = string\n  sensitive = true\n  default   = ""\n}', null],
  ['a token variable with a literal default', 'variables.tf', 'variable "api_token" {\n  sensitive = true\n  default   = "hunter2"\n}', /variable "api_token" a literal default/],
  ['a secret variable defaulting to null', 'variables.tf', 'variable "client_secret" {\n  sensitive = true\n  default   = null\n}', null],
  ['a password variable with a heredoc default', 'variables.tf', 'variable "db_password" {\n  sensitive = true\n  default   = <<EOT\nhunter2\nEOT\n}', /variable "db_password" a literal default/],
  ['a password variable whose description names sensitive', 'variables.tf', 'variable "db_password" {\n  description = "Set sensitive = true on callers"\n}', /variable "db_password" without sensitive = true/],
  ['a secret ARN variable', 'variables.tf', 'variable "secret_arn" {\n  type = string\n}', null],
  ['a password length variable', 'variables.tf', 'variable "password_length" {\n  default = 16\n}', null],
  ['a token output without sensitive', 'outputs.tf', 'output "token" {\n  value = aws_x.y.token\n}', /output "token" without sensitive = true/],
  ['a sensitive token output', 'outputs.tf', 'output "token" {\n  value     = aws_x.y.token\n  sensitive = true\n}', null],
  // GitHub Actions workflows.
  ['a workflow with static AWS keys', '.github/workflows/deploy.yml', STATIC_KEYS, /role-to-assume and permissions: id-token: write/],
  ['a workflow with keys in env, on a Windows path', 'C:\\repo\\.github\\workflows\\ci.yaml', 'env:\n  AWS_ACCESS_KEY_ID:   ${{ secrets.KEY }}\n  AWS_SECRET_ACCESS_KEY: ${{secrets.SECRET}}', /static AWS key/],
  ['a workflow chaining a role from a static key', '.github/workflows/deploy.yml', `${STATIC_KEYS}\n          role-to-assume: arn:aws:iam::1:role/x`, /static AWS key/],
  ['a workflow with a quoted secret in env', '.github/workflows/deploy.yml', 'env:\n  AWS_SECRET_ACCESS_KEY: "${{ secrets.KEY }}"', /static AWS key/],
  ['a workflow with a bracketed secret in env', '.github/workflows/deploy.yml', "env:\n  AWS_ACCESS_KEY_ID: ${{ secrets['KEY'] }}", /static AWS key/],
  ["a workflow passing on an earlier step's temporary keys", '.github/workflows/deploy.yml', `${OIDC_WORKFLOW}\n      - uses: some/action@v1\n        with:\n          aws-access-key-id: \${{ steps.assume.outputs.aws-access-key-id }}\n          aws-secret-access-key: '\${{ needs.auth.outputs.secret }}'`, null],
  ['a workflow using OIDC', '.github/workflows/deploy.yml', OIDC_WORKFLOW, null],
  ['a workflow with an Azure client secret in env', '.github/workflows/deploy.yml', 'env:\n  AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}', /passes a static Azure or Google credential to the job; use workload identity federation \(id-token: write, with azure\/login client-id, tenant-id and subscription-id, or google-github-actions\/auth with workload_identity_provider\)/],
  ['a workflow with a Google key file', '.github/workflows/deploy.yml', "steps:\n  - uses: google-github-actions/auth@v2\n    with:\n      credentials_json: '${{ secrets.GCP_SA_KEY }}'", /static Azure or Google credential/],
  ['a workflow with Azure creds JSON', '.github/workflows/deploy.yml', 'steps:\n  - uses: azure/login@v2\n    with:\n      creds: ${{ secrets.AZURE_CREDENTIALS }}', /static Azure or Google credential/],
  ['a workflow with static AWS and Azure credentials', '.github/workflows/deploy.yml', `${STATIC_KEYS}\n      - uses: azure/login@v2\n        with:\n          creds: \${{ secrets.AZURE_CREDENTIALS }}`, /static AWS key.*; and passes a static Azure or Google credential/],
  ['a workflow with a quoted creds key', '.github/workflows/deploy.yml', 'steps:\n  - uses: azure/login@v2\n    with:\n      "creds": ${{ secrets.AZURE_CREDENTIALS }}', /static Azure or Google credential/],
  ['a workflow with a Google key file in a block scalar', '.github/workflows/deploy.yml', 'steps:\n  - uses: google-github-actions/auth@v2\n    with:\n      credentials_json: >-\n        ${{ secrets.GCP_SA_KEY }}', /static Azure or Google credential/],
  ['a workflow naming creds only in a trailing comment', '.github/workflows/deploy.yml', 'env:\n  OTHER: value # creds: ${{ secrets.OLD }}', null],
  ['a workflow using Azure OIDC', '.github/workflows/deploy.yml', 'permissions:\n  id-token: write\nsteps:\n  # creds: ${{ secrets.OLD }}\n  - uses: azure/login@v2\n    with:\n      client-id: ${{ secrets.AZURE_CLIENT_ID }}\n      tenant-id: ${{ secrets.AZURE_TENANT_ID }}\n      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}', null],
  ['a workflow using Google workload identity', '.github/workflows/deploy.yml', 'steps:\n  - uses: google-github-actions/auth@v2\n    with:\n      workload_identity_provider: projects/1/locations/global/workloadIdentityPools/gh/providers/gh\n      service_account: ci@p.iam.gserviceaccount.com', null],
  ["a workflow passing on a step's or job's credential", '.github/workflows/deploy.yml', 'steps:\n  - uses: some/action@v1\n    with:\n      creds: ${{ steps.vault.outputs.creds }}\n      credentials_json: ${{ needs.auth.outputs.json }}\n    env:\n      AZURE_CLIENT_SECRET: ${{ steps.vault.outputs.secret }}', null],
  ['key inputs outside a workflow', 'docs/config.yml', 'aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}', null],
  // Found in the hardening pass. Secrets: an escaped quote, the key's other spellings, a key after _ and EXAMPLE added to a real value.
  ['a secret key behind escaped quotes in a script', 's.sh', `echo "secret_${'key'} = \\"${K}\\"" > t.tf`, undefined],
  ['a secret key behind backtick-escaped quotes', 's.ps1', `"secret_${'key'} = \`"${K}\`"" | Set-Content t.tf`, undefined],
  ['a secret key in JSON nested in a string', 'cfg.json', `{"cfg":"{\\"aws_secret_access_${'key'}\\":\\"${K}\\"}"}`, undefined],
  ['a secret key in JSON nested twice', 'cfg.json', JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ [`secret_${'key'}`]: K }) }) }), undefined],
  ['a hyphenated secret key in a workflow', '.github/workflows/deploy.yml', `with:\n  aws-secret-access-${'key'}: ${K}`, undefined],
  ['a secret key handed to aws configure set', 'setup.sh', `aws configure set aws_secret_access_${'key'} ${K}`, undefined],
  ['a secret key in STS XML', 'creds.xml', `<SecretAccess${'Key'}>${K}</SecretAccess${'Key'}>`, undefined],
  ['a dotted secret key in a properties file', 'app.properties', `aws.secret.${'key'}=${K}`, undefined],
  ['a secret key after a hash rocket', 'config.rb', `secret_access_${'key'} => '${K}'`, undefined],
  ['a secret key after a long run of spaces', 'terraform.tfvars', `secret_${'key'}${' '.repeat(40)}= "${K}"`, undefined],
  ['an access key after an underscore', 'notes.md', `KEY_${KEY}`, undefined],
  ['an access key before an underscore', 'notes.md', `${KEY}_OLD`, undefined],
  ['a secret key with EXAMPLE after it', '.env', `AWS_SECRET_ACCESS_${'KEY'}=${K}#EXAMPLE`, undefined],
  ['a placeholder-shaped secret key that is not the sample', '.env', `AWS_SECRET_ACCESS_${'KEY'}=${'abcdEXAMPLE'}${'x'.repeat(29)}`, undefined],
  ['a GitHub token with EXAMPLE after it', 'notes.md', `${'ghp'}_${'a'.repeat(36)}EXAMPLE`, undefined],
  ['a GitHub token with EXAMPLE inside it', 'notes.md', `${'ghp'}_${'a'.repeat(18)}EXAMPLE${'a'.repeat(18)}`, undefined],
  ["AWS's sample access key after an underscore", 'notes.md', 'KEY_AKIAIOSFODNN7EXAMPLE', null],
  ["AWS's second sample secret key", 'README.md', `aws_secret_access_${'key'} = je7MtGbClwBF/2Zp9Utk/${'h3yCo8nvb'}EXAMPLEKEY`, null],
  ["AWS's sample secret key behind escaped quotes", 'README.md', `{"a":"{\\"SecretAccess${'Key'}\\":\\"wJalrXUtnFEMI/K7MDENG/${'bPxRfiCY'}EXAMPLEKEY\\"}"}`, null],
  ['a GitHub token placeholder', 'README.md', 'GITHUB_TOKEN=ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE', null],
  ['prose about the secret key', 'README.md', 'The secret key is rotated every ninety days; aws configure set aws_secret_access_key reads it from the vault.', null],
  ['a secret key path', 'main.tf', 'secret_key_path = "/etc/app/keys/current/service/account/main.pem"', null],
  // Ports: the rule's type decides its direction, not its name.
  ['an SSH ingress rule named for egress', 'sg.tf', SSH_RULE('ingress', 'egress_proxy_ssh'), /port 22 /],
  ['an SSH egress rule named for ingress', 'sg.tf', SSH_RULE('egress', 'ingress_ssh_out'), null],
  ['an inline egress block in a group named for ingress', 'sg.tf', 'resource "aws_security_group" "ingress" {\n  egress {\n    from_port = 0\n    to_port = 0\n    protocol = "-1"\n    cidr_blocks = ["0.0.0.0/0"]\n  }\n}', null],
  // Workflows: a stored key in a run step or a block scalar, and composite actions.
  ['a workflow exporting a stored key in a run step', '.github/workflows/deploy.yml', 'steps:\n  - run: export AWS_ACCESS_KEY_ID=${{ secrets.K }}', /static AWS key/],
  ['a workflow writing a stored key to GITHUB_ENV', '.github/workflows/deploy.yml', 'steps:\n  - run: echo "AWS_SECRET_ACCESS_KEY=${{ secrets.K }}" >> "$GITHUB_ENV"', /static AWS key/],
  ['a workflow running aws configure set with a stored key', '.github/workflows/deploy.yml', 'steps:\n  - run: aws configure set aws_secret_access_key ${{ secrets.K }}', /static AWS key/],
  ['a workflow running aws configure set for a profile', '.github/workflows/deploy.yml', 'steps:\n  - run: aws configure set profile.ci.aws_access_key_id "${{ secrets.K }}"', /static AWS key/],
  ['a workflow with a stored key in a block scalar', '.github/workflows/deploy.yml', 'env:\n  AWS_SECRET_ACCESS_KEY: >-\n    ${{ secrets.K }}', /static AWS key/],
  ['a workflow setting a region with aws configure set', '.github/workflows/deploy.yml', 'steps:\n  - run: aws configure set region ${{ secrets.REGION }}\n  - run: export AWS_REGION=${{ secrets.REGION }}', null],
  ['a workflow exporting temporary keys from a step', '.github/workflows/deploy.yml', 'steps:\n  - run: export AWS_ACCESS_KEY_ID=${{ steps.assume.outputs.id }}', null],
  ['a composite action with static AWS keys', '.github/actions/aws-login/action.yml', STATIC_KEYS, /static AWS key/],
  ['a nested composite action on a Windows path', 'C:\\repo\\.github\\actions\\aws\\login\\action.yaml', 'runs:\n  steps:\n    - run: export AWS_ACCESS_KEY_ID=${{ secrets.K }}', /static AWS key/],
  ['a composite action using OIDC', '.github/actions/aws-login/action.yml', OIDC_WORKFLOW, null],
  ['another file beside a composite action', '.github/actions/aws-login/config.yml', STATIC_KEYS, null],
  ['an action.yml outside .github', 'vendor/actions/aws-login/action.yml', STATIC_KEYS, null],
  // Secret names: API keys.
  ['an API key variable with a literal default', 'variables.tf', 'variable "api_key" {\n  default = "abc123"\n}', /variable "api_key" without sensitive = true; and gives variable "api_key" a literal default/],
  ['an api-key variable', 'variables.tf', 'variable "stripe-api-key" {\n  type = string\n}', /variable "stripe-api-key" without sensitive = true/],
  ['an apikey output', 'outputs.tf', 'output "apikey" {\n  value = x.y.key\n}', /output "apikey" without sensitive = true/],
  ['a sensitive API key variable', 'variables.tf', 'variable "api_key" {\n  type      = string\n  sensitive = true\n}', null],
  ['an API key name variable', 'variables.tf', 'variable "api_key_name" {\n  default = "primary"\n}', null],
  ['an API key source variable', 'variables.tf', 'variable "api_key_source" {\n  default = "HEADER"\n}', null],
  ['an API key required switch', 'variables.tf', 'variable "api_key_required" {\n  type    = bool\n  default = false\n}', null],
  ['an API key type and file variable', 'variables.tf', 'variable "api_key_type" {\n  default = "ed25519"\n}\nvariable "api-key_file" {\n  default = "keys/api.pub"\n}', null],
  ['a bool variable named for an API key', 'variables.tf', 'variable "use_api_key" {\n  type = bool\n}\nvariable "rotate_apikey" {\n  default = true\n}', null],
  ['an API key variable with a string default beside a switch', 'variables.tf', 'variable "api_key_required" {\n  type = bool\n}\nvariable "apikey" {\n  type    = string\n  default = "abc123"\n}', /variable "apikey" without sensitive = true; and gives variable "apikey" a literal default/],
  // An output declared under a key input's name is not a key handed to the job.
  ['a composite action that outputs temporary keys', '.github/actions/aws-login/action.yml', KEY_OUTPUTS, null],
  ['a reusable workflow that outputs temporary keys', '.github/workflows/assume.yml', 'on:\n  workflow_call:\n    outputs:\n      aws-access-key-id:\n        description: "The temporary key id"\n        value: ${{ jobs.assume.outputs.id }}', null],
  ['a composite action that outputs a stored key', '.github/actions/aws-login/action.yml', 'outputs:\n  aws-access-key-id:\n    value: ${{ secrets.AWS_ACCESS_KEY_ID }}', /static AWS key/],
  ['a composite action with key outputs and a stored key in with', '.github/actions/aws-login/action.yml', `${KEY_OUTPUTS}\n        aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}`, /static AWS key/],
  ['a composite action with key outputs and a stored key in env', '.github/actions/aws-login/action.yml', `${KEY_OUTPUTS}\n      env:\n        AWS_SECRET_ACCESS_KEY: \${{ secrets.K }}`, /static AWS key/],
  ['a composite action that declares a key input', '.github/actions/aws-login/action.yml', 'inputs:\n  aws-access-key-id:\n    description: A static key id\n    required: true', /static AWS key/],
  ['a workflow with a key on the line after its name', '.github/workflows/deploy.yml', 'with:\n  aws-access-key-id:\n    ${{ secrets.AWS_ACCESS_KEY_ID }}', /static AWS key/],
  // OIDC trusts: any provider by reference, and a wildcard audience.
  ['an OIDC trust by reference with no condition', 'role.tf', BY_REFERENCE(''), /trusts an OIDC provider without a :sub condition, so any identity it issues can assume the role.*trusts an OIDC provider without a :aud condition/],
  ['an OIDC trust by reference without sub', 'role.tf', BY_REFERENCE(`        StringEquals = { "${EKS}:aud" = "sts.amazonaws.com" }`), /^(?!.*:aud condition).*trusts an OIDC provider without a :sub condition/],
  ['an OIDC trust by reference with a * sub', 'role.tf', BY_REFERENCE(`        StringEquals = { "${EKS}:aud" = "sts.amazonaws.com" }\n        StringLike = { "${EKS}:sub" = "*" }`), /trusts an OIDC provider without a :sub condition/],
  ['an OIDC trust by reference with sub and aud', 'role.tf', BY_REFERENCE(`        StringEquals = {\n          "${EKS}:aud" = "sts.amazonaws.com"\n          "${EKS}:sub" = "system:serviceaccount:app:api"\n        }`), null],
  ['an OIDC provider output, no trust', 'outputs.tf', 'output "oidc_arn" {\n  value = aws_iam_openid_connect_provider.this.arn\n}', null],
  ['a GitHub OIDC trust with a * aud', 'role.tf', ROLE(`        StringLike = { "${GH}:aud" = "*" }\n${SUB('"repo:acme/infra:*"')}`), /trusts GitHub Actions OIDC without a :aud condition/],
  ['a GitHub OIDC trust with a * aud in a policy document', 'role.tf', DOCUMENT('"repo:acme/infra:*"').replace('["sts.amazonaws.com"]', '["*"]'), /trusts GitHub Actions OIDC without a :aud condition/],
  // Every action, spelled *:*.
  ['a policy granting *:*', 'iam.tf', 'policy = jsonencode({\n  Statement = [{\n    Effect   = "Allow"\n    Action   = "*:*"\n    Resource = "*"\n  }]\n})', /grants every action/],
  ['a policy document listing *:*', 'iam.tf', 'data "aws_iam_policy_document" "d" {\n  statement {\n    actions = ["s3:GetObject", "*:*"]\n  }\n}', /grants every action/],
  // A finding is listed once, however often the text repeats it, and a long list is cut short.
  ['a secret variable repeated to 100 KB', 'variables.tf', 'variable "password" {}\n'.repeat(4500), /^tf-lint: the text just written to variables\.tf declares variable "password" without sensitive = true\. Fix it before finishing\.$/],
  ['more findings than are listed', 'variables.tf', Array.from({ length: 30 }, (_, i) => `variable "password_${i}x" {}`).join('\n'), /variable "password_19x" without sensitive = true; and has 10 more finding\(s\) not listed\. Fix/],
]

// 100 KB of each shape that once took seconds; a hundredth of that now.
const SLOW: readonly (readonly [string, string])[] = [
  ['one long line', `x = "${'a'.repeat(100_000)}"`],
  ['interpolations never closed', '${'.repeat(50_000)],
  ['20,000 nested blocks in a KMS key', `resource "aws_kms_key" "k" {\n${'a{'.repeat(20_000)}${'}'.repeat(20_000)}\n}`],
  ['a secret key name with no value', 'secret_key='.repeat(20_000)],
  ['blank lines', '\n'.repeat(100_000)],
  ['block comments never closed', '/*\n'.repeat(33_000)],
  ['quotes never closed', '"\\'.repeat(50_000)],
  ['sub lists never closed', ':sub" = ['.repeat(11_000)],
  ['KMS keys never closed', 'resource "aws_kms_key" "k" {\n'.repeat(3_500)],
  ['secret variables with different names', Array.from({ length: 4_000 }, (_, i) => `variable "password${i}" {}`).join('\n')],
]

for (const [name, content] of SLOW) {
  test(`Write of ${name} is read in under a second`, async ($, on) => {
    on('tool.call', { tool: ['Write'] }, () => ({ result: {} as never }))

    const started = Date.now()
    const ran = await $.tool.call({ tool: 'Write', file_path: 'main.tf', content })

    expect(ran.deny).toBe(undefined)
    expect(Date.now() - started < 1000).toBe(true)
  })
}


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

// What the deny says, or null when the call runs.
const CALLS: readonly (readonly [string, Record<string, unknown> & { tool: string }, RegExp | null])[] = [
  ['Bash echoing a key into a file', { tool: 'Bash', command: `echo ${KEY} > creds.txt` }, /command would write an AWS access key into a file/],
  ['Bash writing a key with a heredoc', { tool: 'Bash', command: `cat <<EOF\naws_access_key_id = ${KEY}\nEOF` }, /AWS access key into a file/],
  ['Bash piping a token to tee', { tool: 'Bash', command: `echo ${TOKEN} | tee -a ~/.npmrc` }, /private key or API token into a file/],
  ['PowerShell Set-Content with a key', { tool: 'PowerShell', command: `Set-Content -Path creds.txt -Value '${KEY}'` }, /AWS access key into a file/],
  ['Bash writing a key with >&file', { tool: 'Bash', command: `echo ${KEY} >&creds.txt` }, /AWS access key into a file/],
  ['Bash writing a key with =>file', { tool: 'Bash', command: `echo ${KEY}=>creds.txt` }, /AWS access key into a file/],
  ['Bash piping a key to sudo tee', { tool: 'Bash', command: `echo ${KEY} | sudo tee /etc/creds` }, /AWS access key into a file/],
  ['Bash with a key and only stderr folded', { tool: 'Bash', command: `echo ${KEY} 2>&1 | grep -c AKIA` }, null],
  ['Bash grepping a key in a tee.log', { tool: 'Bash', command: `grep -c ${KEY} tee.log` }, null],
  ['the terminal appending a token', { tool: 'mcp__terminal__run_in_terminal', command: `echo ${TOKEN} >> .env` }, /command would write a private key/],
  ['Monitor appending a token', { tool: 'Monitor', command: `echo ${TOKEN} >> .env` }, /command would write a private key/],
  ['Monitor tailing a log', { tool: 'Monitor', command: 'tail -f app.log' }, null],
  ["Bash writing AWS's sample key", { tool: 'Bash', command: 'echo AKIAIOSFODNN7EXAMPLE > notes.txt' }, null],
  ['Bash with stderr folded into a pipe', { tool: 'Bash', command: 'npm test 2>&1 | tail -5' }, null],
  ['Bash redirecting a log', { tool: 'Bash', command: 'git log > log.txt' }, null],
  ['Bash reading a key without writing a file', { tool: 'Bash', command: `grep -c ${KEY} access.log` }, null],
  ['an MCP send with a token in its body', { tool: 'mcp__gmail__send', to: 'x', body: `here it is: ${TOKEN}` }, /send a private key or API token to mcp__gmail__send/],
  ['an MCP send with ordinary text', { tool: 'mcp__gmail__send', to: 'x', body: 'lunch at noon -> room 4' }, null],
  // Found in the hardening pass.
  ['Bash echoing a secret key behind escaped quotes', { tool: 'Bash', command: `echo "secret_${'key'} = \\"${K}\\"" > t.tf` }, /AWS access key into a file/],
  ['PowerShell piping a secret key behind escaped quotes', { tool: 'PowerShell', command: `"secret_${'key'} = \`"${K}\`"" | Set-Content t.tf` }, /AWS access key into a file/],
  ['Bash handing a secret key to aws configure set', { tool: 'Bash', command: `aws configure set aws_secret_access_${'key'} ${K}` }, /AWS access key into a file/],
  ['PowerShell handing a secret key to aws configure set', { tool: 'PowerShell', command: `aws configure set aws_secret_access_${'key'} ${K} --profile ci` }, /AWS access key into a file/],
  ['Monitor handing an access key to aws configure set', { tool: 'Monitor', command: `aws configure set aws_access_key_id ${KEY}` }, /AWS access key into a file/],
  ['the terminal handing a token to npm config set', { tool: 'mcp__terminal__run_in_terminal', command: `npm config set //registry.npmjs.org/:_authToken ${TOKEN}` }, /private key or API token into a file/],
  ['Bash writing a key after an underscore', { tool: 'Bash', command: `echo KEY_${KEY} > creds.txt` }, /AWS access key into a file/],
  ['PowerShell writing a key after an underscore', { tool: 'PowerShell', command: `Add-Content creds.txt 'KEY_${KEY}'` }, /AWS access key into a file/],
  ['Bash appending a token with EXAMPLE after it', { tool: 'Bash', command: `echo ${TOKEN}EXAMPLE >> .env` }, /private key or API token into a file/],
  ['PowerShell writing a secret key with EXAMPLE after it', { tool: 'PowerShell', command: `Set-Content .env 'AWS_SECRET_ACCESS_${'KEY'}=${K}#EXAMPLE'` }, /AWS access key into a file/],
  ['Bash setting a region with aws configure set', { tool: 'Bash', command: 'aws configure set region us-gov-west-1' }, null],
  ['PowerShell setting a region with aws configure set', { tool: 'PowerShell', command: 'aws configure set region us-gov-west-1 --profile ci' }, null],
  ["Bash handing AWS's sample keys to aws configure set", { tool: 'Bash', command: `aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE && aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/${'bPxRfiCY'}EXAMPLEKEY` }, null],
  ['PowerShell writing a token placeholder', { tool: 'PowerShell', command: "Set-Content README.md 'GITHUB_TOKEN=ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE'" }, null],
  ['Bash reading a secret key without writing a file', { tool: 'Bash', command: `grep -c "secret_${'key'} = \\"${K}\\"" main.tf` }, null],
  ['an MCP call with a secret key in JSON nested twice', { tool: 'mcp__http__post', body: JSON.stringify({ cfg: JSON.stringify({ [`secret_${'key'}`]: K }) }) }, /send an AWS access key to mcp__http__post/],
  ['an MCP call with a secret key behind unicode escapes', { tool: 'mcp__http__post', body: `{"cfg":"secret_${'key'}=\\u0022${K}\\u0022"}` }, /send an AWS access key to mcp__http__post/],
  ['an MCP call with a token in a JSON string of a JSON string', { tool: 'mcp__http__post', body: JSON.stringify(JSON.stringify({ t: `${'ghp'}_\u0063${'c'.repeat(35)}` })) }, /send a private key or API token to mcp__http__post/],
  ['an MCP call with ordinary nested JSON', { tool: 'mcp__http__post', body: JSON.stringify({ cfg: JSON.stringify({ note: 'lunch at noon', secret_key: 'from the vault' }) }) }, null],
  ['an MCP call with a string that only looks like JSON', { tool: 'mcp__notes__create', note: '{ not json at all' }, null],
  ['an MCP call with a secret key in a nested string', { tool: 'mcp__notes__create', note: { text: `secret_${'key'} = "${'wJalrXUtnFEMIK7MDENGbPxRfiCY'}abcdefghijkl"` } }, /send an AWS access key to mcp__notes__create/],
]

for (const [name, call, expected] of CALLS) {
  test(`${call.tool}: ${name}`, async ($, on) => {
    let hasRun = false

    on('tool.call', () => {
      hasRun = true

      return { result: {} as never }
    })

    const ran = await $.tool.call(call as never)

    expect(hasRun).toBe(expected === null)

    if (expected !== null) {
      expect(ran.deny).toMatch(expected)
    }
  })
}

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
      // A warning or a clean row is never also a deny.
      expect(ran.deny === undefined).toBe(expected !== undefined)

      if (expected === null) {
        expect(context).toBe('')
      } else if (expected !== undefined) {
        expect(context).toMatch(expected)
      }
    })
  }
}
