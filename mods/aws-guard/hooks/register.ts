import type { Register } from 'claude-code'

import { invocations } from './shell'

const BINARY = /^(.*[\\/])?aws(\.exe|\.cmd)?$/i
// pip's AWS CLI also runs as a module: python -m awscli iam delete-role.
const PYTHON = /^(.*[\\/])?py(thon[\d.]*)?(\.exe)?$/i
// Global options that take a value, which is not the service or the operation.
const VALUE_OPTION =
  /^--(profile|region|output|endpoint-url|query|color|ca-bundle|cli-read-timeout|cli-connect-timeout|cli-binary-format)$/
const r = String.raw
// The operations denied, by AWS CLI service: what turns off logging or detection, opens S3 to the public, changes who can do what
// in IAM or KMS, or destroys data that IAM often allows. Creating and deploying (create-role, put-object, run-instances) pass.
// shortcut: the AWS CLI and AWS Tools for PowerShell; SDK scripts and cmdlets called through a variable pass, upgrade if those come into use.
// shortcut: a list of known calls, not a read allowlist, so a service or operation not named here runs; add the row when one bites.
const OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  // Any Organizations call but a read.
  organizations: [r`(?!describe-|list-|help$)[a-z][\w-]*`],
  iam: [
    r`(delete|remove)-[\w-]+`,
    '(attach|detach|put)-(user|group|role)-policy',
    'put-(user|role)-permissions-boundary',
    'update-assume-role-policy',
    'create-policy-version',
    'set-default-policy-version',
    'add-user-to-group',
    '(create|update)-(access-key|login-profile)',
    '(create|reset)-service-specific-credential',
    'deactivate-mfa-device',
    'update-account-password-policy',
    // Any change to a federation provider: create, update, add or remove a client ID or thumbprint.
    r`(?!get-|list-)[\w-]*(saml|open-id-connect)-provider[\w-]*`,
  ],
  kms: [
    'schedule-key-deletion',
    'delete-imported-key-material',
    'disable-key',
    'disable-key-rotation',
    'put-key-policy',
    '(create|revoke|retire)-grant',
    '(delete|disconnect)-custom-key-store',
  ],
  cloudtrail: [
    'stop-logging',
    'stop-event-data-store-ingestion',
    '(delete|update)-(trail|event-data-store)',
    'put-(event|insight)-selectors',
  ],
  guardduty: [
    r`(delete|disassociate)-[\w-]+`,
    'stop-monitoring-members',
    r`update-(detector|member-detectors|organization-configuration|malware-[\w-]+)`,
    // A filter can archive findings as they arrive and an IP set can trust an address.
    '(create|update)-(filter|ip-set)',
  ],
  configservice: ['stop-configuration-recorder', r`delete-[\w-]+`],
  securityhub: [
    r`(disable|delete|disassociate)-[\w-]+`,
    'batch-disable-standards',
    'update-standards-control',
    'batch-update-standards-control-associations',
    'update-(organization|security-hub)-configuration',
  ],
  logs: ['delete-log-(group|stream)', 'put-retention-policy'],
  ec2: [
    'delete-flow-logs',
    'terminate-instances',
    'delete-(snapshot|volume)',
    'disable-ebs-encryption-by-default',
    'disable-(image|snapshot)-block-public-access',
  ],
  s3: ['rb'],
  s3api: [
    '(put|delete)-public-access-block',
    '(put|delete)-bucket-policy',
    'put-bucket-acl',
    'delete-bucket-encryption',
    'delete-bucket',
    'delete-objects',
  ],
  s3control: ['(put|delete)-public-access-block'],
  rds: ['delete-(db-instance|db-cluster|global-cluster|db-snapshot|db-cluster-snapshot|db-(instance|cluster)-automated-backup)'],
  dynamodb: ['delete-(table|backup)'],
  backup: [r`delete-[\w-]+`],
  efs: ['delete-file-system'],
  route53: ['delete-hosted-zone'],
  route53domains: ['delete-domain', 'disable-domain-transfer-lock', 'transfer-domain-to-another-aws-account'],
}
const DENIED = new Map(
  Object.entries(OPERATIONS).map(([service, operations]) => [service, new RegExp(`^(${operations.join('|')})$`)]),
)
// Calls denied only with the option that makes them destroy: one `s3 rm` and a secret deleted with its recovery window still run.
// The CLI takes an option by any unambiguous prefix, so the shortest one is matched.
const DENIED_WITH = new Map([
  ['s3 rm', /^--rec/],
  // Its JSON input can carry ForceDeleteWithoutRecovery, and is not read.
  ['secretsmanager delete-secret', /^--(f|cli-input)/],
])
// The option that makes a call only say what it would do, for the services that have one.
const DRY_RUN = new Map([
  ['ec2', '--dry-run'],
  ['s3', '--dryrun'],
])

// The AWS Tools for PowerShell cmdlets for the same calls, module-qualified or not, a line per service's noun prefix.
// shortcut: Remove-<prefix>* also takes the untag cmdlets (Remove-IAMRoleTag), which the CLI's untag-* does not; exclude them if that bites.
const CMDLET_NAME = [
  // Any Organizations verb but Get (Move-ORGAccount, New-ORGOrganization); Exchange's Remove-OrganizationRelationship is not one.
  r`(?!Get-)[a-z]+-ORG(?!aniz)\w+`,
  r`Remove-IAM\w+|(Register|Unregister|Write)-IAM(User|Group|Role)Policy|Set-IAM(User|Role)PermissionsBoundary`,
  r`Update-IAMAssumeRolePolicy|New-IAMPolicyVersion|Set-IAMDefaultPolicyVersion|Add-IAMUserToGroup`,
  r`(New|Update)-IAM(AccessKey|LoginProfile)|(New|Reset)-IAMServiceSpecificCredential|Disable-IAMMFADevice`,
  r`Update-IAMAccountPasswordPolicy|(?!Get-)[a-z]+-IAM\w*(SAML|OpenIDConnect)Provider\w*`,
  r`Request-KMSKeyDeletion|Remove-KMSImportedKeyMaterial|Disable-KMSKey(Rotation)?|Write-KMSKeyPolicy`,
  r`(New|Revoke|Disable)-KMSGrant|(Remove|Disconnect)-KMSCustomKeyStore`,
  r`Stop-CT(Logging|EventDataStoreIngestion)|(Remove|Update)-CT(Trail|EventDataStore)|Write-CT(Event|Insight)Selector`,
  r`(Remove|Unregister|Stop)-GD\w+|Update-GD(Detector|MemberDetector|OrganizationConfiguration|Malware\w+|Filter|IPSet)|New-GD(Filter|IPSet)`,
  r`Stop-CFGConfigurationRecorder|Remove-CFG\w+`,
  r`(Disable|Remove|Unregister)-SHUB\w+|Update-SHUB(StandardsControl\w*|OrganizationConfiguration|SecurityHubConfiguration)`,
  r`Remove-CWLLog(Group|Stream)|Write-CWLRetentionPolicy`,
  r`Remove-EC2(FlowLogs?|Instance|Snapshot|Volume)|Disable-EC2(EbsEncryptionByDefault|(Image|Snapshot)BlockPublicAccess)`,
  r`(Add|Remove)-S3C?PublicAccessBlock|(Write|Remove)-S3BucketPolicy|Set-S3ACL|Remove-S3BucketEncryption|Remove-S3Bucket`,
  r`Remove-RDS(DBInstance|DBCluster|GlobalCluster|DBSnapshot|DBClusterSnapshot|DB(Instance|Cluster)AutomatedBackup)`,
  r`Remove-DDB(Table|Backup)|Remove-BAK\w+|Remove-EFSFileSystem|Remove-R53HostedZone`,
  r`(Remove|Move)-R53DDomain\w*|Disable-R53DDomainTransferLock`,
].join('|')
const named = (name: string) => new RegExp(r`^([\w.]+\\)?(${name})$`, 'i')
const CMDLET = named(CMDLET_NAME)
const CMDLET_IN_TEXT = new RegExp(r`(?<![\w-])(${CMDLET_NAME})(?![\w-])`, 'i')
const has = (parameter: RegExp) => (args: readonly string[]) => args.some(arg => parameter.test(arg))
// Cmdlets denied only by their arguments: Stop-EC2Instance -Terminate, a secret deleted with no recovery window, and Remove-S3Object
// without the one -Key it deletes (a piped or listed set of keys). PowerShell takes a parameter by any unambiguous prefix.
const CMDLET_WITH: readonly (readonly [RegExp, string, (args: readonly string[]) => boolean])[] = [
  [named('Stop-EC2Instance'), 'Stop-EC2Instance -Terminate', has(/^-T/i)],
  [named('Remove-SECSecret'), 'Remove-SECSecret -ForceDeleteWithoutRecovery', has(/^-(ForceD|Del)/i)],
  [named('Remove-S3Object'), 'Remove-S3Object', args => !has(/^-Key(:|$)/i)(args)],
]

// The service and operation are the first two bare words, wherever the global options sit.
const mutation = (args: readonly string[]): string | undefined => {
  const bare = args.flatMap((word, i) => (word.startsWith('-') || VALUE_OPTION.test(args[i - 1] ?? '') ? [] : [i]))

  for (const [nth, serviceAt] of bare.entries()) {
    const operationAt = bare[nth + 1] ?? args.length
    const [service = '', operation] = [args[serviceAt], args[operationAt]]

    if (operation === undefined) {
      return undefined
    }

    const call = `${service} ${operation}`
    const dryRun = DRY_RUN.get(service)
    // `help` right after the operation, a skeleton and a dry run only print: nothing is called. `--role-name help` is a value.
    // --no-dry-run after --dry-run takes it back.
    const isDryRun =
      args[operationAt + 1] === 'help' ||
      args.includes('--generate-cli-skeleton') ||
      (dryRun !== undefined && args.includes(dryRun) && !args.includes('--no-dry-run'))
    const option = DENIED_WITH.get(call)
    const isDenied = option === undefined ? DENIED.get(service)?.test(operation) : has(option)(args)

    if (!isDryRun && isDenied) {
      return call
    }

    // A word after an option may be its value, not the service: VALUE_OPTION misses abbreviations (--prof x) and new options.
    if (!(args[serviceAt - 1] ?? '').startsWith('-')) {
      return undefined
    }
  }

  return undefined
}

// -WhatIf only says what the cmdlet would do.
const isWhatIf = (args: readonly string[]) => args.some(arg => /^-WhatIf(:\$true)?$/i.test(arg))

// The call to name in the deny: the CLI's service and operation, or the cmdlet as written.
const denied = (command: string): string | undefined => {
  const viaPython = invocations(command, PYTHON).filter(args => args[0] === '-m' && args[1] === 'awscli').map(args => args.slice(2))
  const cli = [...invocations(command, BINARY), ...viaPython].map(mutation).find(Boolean)
  if (cli !== undefined) {
    return `aws ${cli}`
  }
  // The parser hands back a call's arguments, not its name, so the name is found in the text.
  if (invocations(command, CMDLET).some(args => !isWhatIf(args))) {
    return command.match(CMDLET_IN_TEXT)?.[0] ?? 'an AWS Tools for PowerShell call'
  }

  return CMDLET_WITH.find(([cmdlet, , isDenied]) =>
    invocations(command, cmdlet).some(args => !isWhatIf(args) && isDenied(args)),
  )?.[1]
}

// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
// shortcut: any other MCP tool that runs a command is not read; deny it by name in managed settings (permissions.deny) or add it here.

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: SHELL_TOOLS }, ($, e, next) => {
    // A Monitor that opens a WebSocket has no command.
    const command = String((e as { command?: unknown }).command ?? '')
    const call = denied(command)

    return call === undefined
      ? next(e)
      : {
          deny: `${$.plugin.name}: \`${call}\` needs the user's explicit confirmation. Give them the exact command to run themselves with the \`!\` prefix.`,
        }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
