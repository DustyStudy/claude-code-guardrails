import type { Register } from 'claude-code'

import { DYNAMIC, invocations, namedByShell, unreadable } from './shell'

const BINARY = /^(.*[\\/])?aws(\.exe|\.cmd)?$/i
// The AWS CLI's container image, which takes the call as the binary does: docker run amazon/aws-cli iam delete-role.
const IMAGE = /(^|\/)aws-cli(:[\w.-]+)?(@sha256:\w+)?$/i
// Programs that run aws from their own arguments and are not among the shared parser's wrappers: python (-m awscli is pip's AWS CLI),
// the package and environment runners, the credential helpers, ssh and the container tools.
// shortcut: a list of names, so a runner not named here hides the call; add it when one is seen in use.
const RUNNER =
  /^(.*[\\/])?(py(thon[\d.]*)?|uvx?|poetry|pipx|pipenv|pdm|hatch|rye|conda|mamba|micromamba|pixi|npx|bunx|saml2aws|aws-okta|awsume|granted|assume|gimme-aws-creds|chamber|ssh|sshpass|docker|podman|nerdctl|kubectl)(\.exe|\.cmd)?$/i
// Global options that take a value, which is not the service or the operation.
const VALUE_OPTION =
  /^--(profile|region|output|endpoint-url|query|color|ca-bundle|cli-read-timeout|cli-connect-timeout|cli-binary-format)$/
// Global options that take none, and an option written with its value (--endpoint-url=x): the word after one is not its value.
const NO_VALUE = /^--(debug|no-verify-ssl|no-paginate|no-sign-request|no-cli-pager|(no-)?cli-auto-prompt|version)$|=/
// More option-led words before the operation, or more aws calls in one runner or cmdlet calls in one command, than any real
// command has: denied, not read on, so the work stays linear in the command's length.
const MOST = 64
const TOO_LONG = 'with more options than the guard reads'
const UNREAD = 'with an operation the shell fills in'
// Put in a second reading of the command before each $( ), ` ` and ( ), so the word a substitution stands in or is joined to is
// known: the parser says only that a call has one. A Unicode noncharacter, so no command is written with it.
const MARK = '\uFDD3'
// A word the shell fills in: a marked substitution, a variable ($OP, ${OP}, $env:OP, cmd's %OP% and !OP!), a glob (r? is rb
// beside a file of that name) or PowerShell's @splat.
const FILLED = new RegExp(String.raw`[$${MARK}*?[]|[%!]\w+[%!]|^@\w`)
// Put in that second reading before each $ and opening backtick that is not surely inside double quotes: bash splits what an
// unquoted one leaves into words, so `--profile $P` can be `--profile x iam delete-role`. cmd pastes %P% in as text, quoted or not.
const UNQUOTED = '\uFDD4'
const SPLIT = new RegExp(String.raw`${UNQUOTED}|[%!]\w+[%!]`)
// The verbs of the Organizations and Identity Center writes: no service's name starts with one.
const WRITE_VERB =
  /^(accept|attach|cancel|close|create|decline|delete|deregister|detach|disable|enable|invite|leave|move|provision|put|register|remove|tag|untag|update)-/
const r = String.raw
// The operations denied, by AWS CLI service: what turns off logging or detection, opens S3 to the public, changes who can do what
// in IAM or KMS, or destroys data that IAM often allows. Creating and deploying (create-role, put-object, run-instances) pass.
// shortcut: an SDK script file and a cmdlet name only known at run time pass (see sdkCall and throughVariables); upgrade if those come into use.
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
    '(upload|update)-(ssh-public-key|signing-certificate)',
    '(create|reset)-service-specific-credential',
    'deactivate-mfa-device',
    'update-account-password-policy',
    // Any change to a federation provider: create, update, add or remove a client ID or thumbprint.
    r`(?!get-|list-)[\w-]{0,40}(saml|open-id-connect)-provider[\w-]{0,40}`,
  ],
  // IAM Identity Center: any call but a read hands out account access; its directory's users and groups are who gets it.
  'sso-admin': [r`(?!describe-|list-|get-|help$)[a-z][\w-]*`],
  identitystore: [r`(create|update|delete)-[\w-]+`],
  // A trust anchor or profile lets any certificate the anchor signs take a role; a CRL is what revokes one, and an attribute
  // mapping decides which session tags a certificate sets.
  rolesanywhere: [
    '(create|update|enable)-(trust-anchor|profile)',
    r`delete-[\w-]+`,
    '(import|update|enable|disable)-crl',
    'put-attribute-mapping',
  ],
  // Writes a CSV's static keys into the credentials file.
  configure: ['import'],
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
// Services whose every call but a read is denied: any word is an operation of theirs.
const ANY_WRITE = new Set(['organizations', 'sso-admin'])
// Calls denied only with the option that makes them destroy: one `s3 rm` and a secret deleted with its recovery window still run.
// The CLI takes an option by any unambiguous prefix, so the shortest one is matched.
const DENIED_WITH = new Map([
  ['s3 rm', /^--rec/],
  // Its JSON input can carry ForceDeleteWithoutRecovery, and is not read.
  ['secretsmanager delete-secret', /^--(f|cli-input)/],
  // A static key written to disk; `profile.dev.aws_secret_access_key` names one profile's. Setting the region still runs.
  // The CLI reads a config file's key names in any case, so AWS_SECRET_ACCESS_KEY is the same key.
  ['configure set', /(^|\.)aws_(access_key_id|secret_access_key|session_token)$/i],
])
const GUARDED = new Set([...DENIED.keys(), ...[...DENIED_WITH.keys()].map(call => call.split(' ')[0] ?? '')])
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
  r`(Publish|Update)-IAM(SSHPublicKey|SigningCertificate)`,
  // Identity Center's admin cmdlets but Get; the identity store's writes, by full noun (Find- and Assert-IDS* are reads).
  r`(?!Get-)[a-z]+-SSOADMN\w+|(New|Update|Remove)-IDS(User|Group(Membership)?|IdentityStore)`,
  r`(New|Update|Enable)-IAMRA(TrustAnchor|Profile)|(Import|Update|Enable|Disable)-IAMRACrl|Write-IAMRAAttributeMapping`,
  r`Update-IAMAccountPasswordPolicy|(?!Get-)[a-z]+-IAM\w{0,40}(SAML|OpenIDConnect)Provider\w{0,40}`,
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
// -AccessKey, -SecretKey, -SessionToken, -Credential (the only C parameter) or their aliases AK, SK, ST; -Se and -St alone are ambiguous.
const hasKey = has(/^-(Ac|AK(:|$)|Sec|SK(:|$)|Ses|ST(:|$)|C)/i)
// Cmdlets denied only by their arguments: Stop-EC2Instance -Terminate, a secret deleted with no recovery window, Remove-S3Object
// without the one -Key it deletes (a piped or listed set of keys), and a static key saved to a profile (-StoreAs, or the
// default profile Initialize-AWSDefaultConfiguration writes); switching profile or keys for the shell only run.
// PowerShell takes a parameter by any unambiguous prefix.
const CMDLET_WITH: readonly (readonly [string, string, (args: readonly string[]) => boolean])[] = [
  ['Stop-EC2Instance', 'Stop-EC2Instance -Terminate', has(/^-T/i)],
  ['Remove-SECSecret', 'Remove-SECSecret -ForceDeleteWithoutRecovery', has(/^-(ForceD|Del)/i)],
  ['Remove-S3Object', 'Remove-S3Object', args => !has(/^-Key(:|$)/i)(args)],
  ['Set-AWSCredentials?', 'Set-AWSCredential -StoreAs', args => has(/^-StoreA/i)(args) && hasKey(args)],
  ['Initialize-AWSDefault(Configuration|s)', 'Initialize-AWSDefaultConfiguration', hasKey],
]

// The command with UNQUOTED put in, quotes read as bash does.
// shortcut: quotes are followed on one line only, and not past a substitution inside double quotes; in a command of several lines,
// or after such a substitution, every $ counts as unquoted, so a quoted global option's value before the operation is denied there.
const markUnquoted = (text: string): string => {
  let out = ''
  let quote = ''
  let isAnsi = false
  let inBackticks = false
  let isLost = text.includes('\n')

  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? ''

    // A backslash escapes nothing inside '...', but does inside $'...'.
    if (c === '\\' && (quote !== "'" || isAnsi)) {
      out += text.slice(i, i + 2)
      i++
      continue
    }

    const opens = c === '`' && quote !== "'" && !inBackticks

    if (c === '$' || opens) {
      out += quote !== '"' || isLost ? UNQUOTED : ''
      // Its body has quotes of its own, and where it ends is not read.
      isLost ||= quote === '"' && (opens || text[i + 1] === '(')
    }

    if (c === '`' && quote !== "'") {
      inBackticks = !inBackticks
    } else if (quote === '') {
      if (c === '"' || c === "'") {
        quote = c
        isAnsi = c === "'" && text[i - 1] === '$'
      }
    } else if (c === quote) {
      quote = ''
    }

    out += c
  }

  return out
}

// A filled-in word where the service or the operation may stand: any word up to the second one that no option can take as its
// value, but an option-led word and a known global option's value that is one word. After those two, a filled-in word is an argument.
// An option a substitution is joined to (--x=$(echo 1 rb)) can end in any words too.
const isFilled = (args: readonly string[]): boolean => {
  let positional = 0

  for (const [i, word] of args.entries()) {
    const before = args[i - 1] ?? ''

    if (word.startsWith('-') ? !word.includes(MARK) : VALUE_OPTION.test(before) && !SPLIT.test(word)) {
      continue
    }

    if (FILLED.test(word)) {
      return true
    }

    if ((!before.startsWith('-') || NO_VALUE.test(before)) && ++positional === 2) {
      return false
    }
  }

  return false
}

// The service and operation are the first two bare words, wherever the global options sit.
// `valued` holds the options the command's text gives a substitution for a value (--region $(...)).
const mutation = (written: readonly string[], valued: ReadonlySet<string>): string | undefined => {
  // A shell drops an escape inside a word: delete\-role (bash), delete`-role (PowerShell), delete^-role (cmd).
  const args = written.map(word => word.replace(/[\\^`]/g, ''))

  if (isFilled(args)) {
    return UNREAD
  }

  const isSkeleton = args.includes('--generate-cli-skeleton')
  // A $( ), ` ` or PowerShell ( ) stood among the arguments: the shell can put any word there, the operation or an option.
  const isDynamic = args.includes(DYNAMIC)
  // The parser leaves no word where a substitution stood, so an option whose value was one takes no word after it here:
  // in `--region $(...) ec2 describe-instances`, ec2 is the service. The text may show that option in another call, so each
  // reading is still checked: the word after it is a service that may be a value.
  const isValued = isDynamic && args.some(word => valued.has(word))
  const bare = args.flatMap((word, i) => {
    const before = args[i - 1] ?? ''

    return word.startsWith('-') || (VALUE_OPTION.test(before) && !(isDynamic && valued.has(before))) ? [] : [i]
  })
  // With the substitution placed as an option's value, only what a guarded service could be handed is denied: no words at all, a
  // first word that is a denied operation (the service filled in), or a guarded service with no operation written. Otherwise it
  // can stand anywhere, and any call with no operation written is denied.
  const first = args[bare[0] ?? -1]
  let unread = isDynamic && !isValued ? UNREAD : undefined
  let pairs = 0

  // The same for a service with every write denied, by the operation's verb: any word matches its pattern.
  if (isValued && (first === undefined || WRITE_VERB.test(first) || [...DENIED].some(([service, operations]) => !ANY_WRITE.has(service) && operations.test(first)))) {
    return UNREAD
  }

  for (const [nth, serviceAt] of bare.entries()) {
    const service = args[serviceAt] ?? ''
    const dryRun = DRY_RUN.get(service)
    // --no-dry-run after --dry-run takes it back.
    const isDryRun = dryRun !== undefined && args.includes(dryRun) && !args.includes('--no-dry-run')

    let isWritten = false

    for (const operationAt of bare.slice(nth + 1, nth + 1 + MOST)) {
      if (++pairs > MOST) {
        return TOO_LONG
      }

      const operation = args[operationAt] ?? ''
      const call = `${service} ${operation}`
      const option = DENIED_WITH.get(call)
      const isDenied = option === undefined ? DENIED.get(service)?.test(operation) : isDynamic || has(option)(args)

      // `help` right after the operation, a skeleton and a dry run only print: nothing is called. `--role-name help` is a value.
      if (isDenied && args[operationAt + 1] !== 'help' && !isSkeleton && !isDryRun) {
        return call
      }

      // A word after an option may be its value and the operation the next one: the CLI takes a global option anywhere, by any
      // unambiguous prefix (iam --prof dev delete-role, iam --endpoint http://x delete-role).
      const before = args[operationAt - 1] ?? ''

      // An operation written out: no word the shell adds can take its place.
      if (!before.startsWith('-') || NO_VALUE.test(before)) {
        unread = undefined
        isWritten = true
        break
      }
    }

    if (isValued && !isWritten && GUARDED.has(service)) {
      return UNREAD
    }

    // The same before the service: VALUE_OPTION misses abbreviations (--prof x) and new options.
    if (!(args[serviceAt - 1] ?? '').startsWith('-')) {
      return unread
    }
  }

  return unread
}

// The aws calls a runner's arguments start: after the binary or its image, or after -m awscli (python, uv run). A quoted argument
// is a command line of its own (ssh host "aws ...", docker run image sh -c "aws ...").
const inRunner = (args: readonly string[], depth: number, valued: ReadonlySet<string>): string | undefined => {
  let starts = 0

  for (const [i, written] of args.entries()) {
    const word = written.replace(/^--entrypoint=/, '')
    const from =
      BINARY.test(word) || IMAGE.test(word) || /^-\w*mawscli$/.test(word) ? i + 1 : /^-\w*m$/.test(word) && args[i + 1] === 'awscli' ? i + 2 : -1
    // As a container's entrypoint (docker run --entrypoint aws image iam delete-role) the call starts after the image, which is
    // any word: read from each. shortcut: a substitution or variable anywhere after such an entrypoint denies; place the image if that bites.
    const isEntry = word !== written || args[i - 1] === '--entrypoint'
    const isEntrypoint = isEntry && BINARY.test(word)

    // The entrypoint's other forms (podman's JSON list '["aws","iam","delete-role"]') are not read.
    if (isEntry && !isEntrypoint && /aws/i.test(word)) {
      return `aws ${UNREAD}`
    }

    const rest = args.length - from
    const cli =
      from < 0
        ? undefined
        : ++starts > MOST || (isEntrypoint && rest > MOST)
          ? TOO_LONG
          : Array.from({ length: isEntrypoint ? rest : 1 }, (_, n) => mutation(args.slice(from + n), valued)).find(Boolean)
    const call = cli === undefined ? (/\s/.test(word) ? denied(word, depth + 1) : undefined) : `aws ${cli}`

    if (call !== undefined) {
      return call
    }
  }

  return undefined
}

// -WhatIf only says what the cmdlet would do. After -- or --% every word is a value, and so is one a comma joins to the value before it.
const isWhatIf = (args: readonly string[]) => {
  const end = args.findIndex(arg => /^--%?$/.test(arg))

  return args.slice(0, end < 0 ? args.length : end).some((arg, i) => /^-WhatIf(:\$true)?$/i.test(arg) && !(args[i - 1] ?? '').endsWith(','))
}

// Each call's arguments twice: as the parser hands them, quotes gone, and with a quoted or escaped -Word kept from reading as a
// parameter, since PowerShell passes one as a value (-OutVariable '-WhatIf'). What denies is read from both, what allows from the second.
const cmdletCalls = (command: string, name: RegExp): (readonly [readonly string[], readonly string[]])[] => {
  const read = invocations(command, name)
  const strict = read.length > 0 ? invocations(command.replace(/(["'`])-/g, '$1‐'), name) : []

  return read.map((args, i) => [args, (strict.length === read.length ? strict[i] : undefined) ?? []])
}

const HERE_STRING = /@(["'])[ \t]*\r?\n/y

// Where a block comment or a here-string that starts at `at` ends: neither closes at a quote, bracket or line's end inside it.
const spanEnd = (text: string, at: number): number | undefined => {
  const close = (found: number, length: number) => (found < 0 ? text.length : found + length)

  if (text.startsWith('<#', at)) {
    return close(text.indexOf('#>', at + 2), 2)
  }

  HERE_STRING.lastIndex = at
  const here = text[at] === '@' ? HERE_STRING.exec(text) : null

  return here === null ? undefined : close(text.indexOf(`\n${here[1]}@`, at), 3)
}

// A call's own words from the end of its name, read on where the parser stops: PowerShell carries a call through ( ) and { }, over
// a line's end after a backtick, and through a here-string or block comment. A quote or backtick stays in its word, so a quoted
// -Word is no parameter here either. With `quotes` off a quote is a plain character: the name may itself sit inside quotes
// (pwsh -c "..."), where the pairs are not known.
const ownWords = (text: string, from: number, quotes: boolean): string[] => {
  let words = ''
  let depth = 0
  let quote = ''

  // A quote right after the name closes the name's own: & "Stop-EC2Instance" -Terminate.
  for (let i = from + (/["']/.test(text[from] ?? '') ? 1 : 0); i < text.length; i++) {
    const c = text[i] ?? ''
    const end = quote === '' ? spanEnd(text, i) : undefined
    let own = c

    if (end !== undefined) {
      i = end - 1
      own = " ' "
    } else if (c === '`' && quote !== "'") {
      // It escapes the next character: a line's end carries the call on, anything else is part of a value.
      i += text.startsWith('\r\n', i + 1) ? 2 : 1
      own = quote !== '' ? '' : /\s/.test(text[i] ?? '') ? ' ' : '`'
    } else if (quote !== '') {
      quote = c === quote ? '' : quote
      own = ''
    } else if (quotes && (c === '"' || c === "'")) {
      quote = c
    } else if (c === '(' || c === '{') {
      words += depth++ === 0 ? ' ' : ''
      own = ''
    } else if (c === ')' || c === '}') {
      if (depth-- === 0) {
        break
      }

      own = ''
    } else if (depth === 0 && /[;|&\n]/.test(c)) {
      break
    }

    words += depth === 0 ? own : ''
  }

  return words.split(/\s+/)
}

// The call to name in the deny: the CLI's service and operation, or the cmdlet as written.
const denied = (command: string, depth = 0): string | undefined => {
  if (depth > 4) {
    return 'a command nested deeper than the guard reads'
  }

  const valued = new Set([...command.matchAll(/(--[\w-]+)\s+["']?(?:\$\(|`|\()/g)].map(([, option = '']) => option))
  // Read as written, and again with each substitution marked (a nested command line comes from a marked one): the second reading
  // only adds denies, since a mark can part a word (PowerShell's delete`-role).
  const marked = depth > 0 ? command : markUnquoted(command).replace(/`([^`\n]*)`/g, `${MARK}\`$1\``).replace(/\$?\(/g, `${MARK}$&`)

  if (unreadable(marked) !== undefined) {
    return 'a command with more substitutions than the guard reads'
  }

  for (const text of new Set([command, marked])) {
    // A program the shell names ($AWS, $(which aws)) is read as aws once a word names a guarded service, or a filled-in word stands
    // before a denied operation ($AWS $SVC delete-role); other programs ($EDITOR "$FILE") pass. PowerShell's array is one word: & $a @('iam','delete-role').
    const named = namedByShell(text)
    const shellNamed = named.filter(args =>
      args.some(
        (word, i) =>
          word.split(',').some(part => GUARDED.has(part)) ||
          (FILLED.test(args[i - 1] ?? '') && [...DENIED].some(([service, operations]) => !ANY_WRITE.has(service) && operations.test(word))),
      ),
    )
    // The parser drops an unquoted $( ) right after a filled-in program ($(which aws) $(echo iam) delete-role gives delete-role
    // first): a list led by a denied operation is read once with each service that has it, so a dry run or help still runs.
    // shortcut: a service and operation both filled in ($X $(echo iam delete-role)) run; terraform-guard leaves the same open.
    const lost = named.flatMap(args => {
      const operation = (args[0] ?? '').replace(/[\\^`]/g, '')
      const services = [
        ...[...DENIED].filter(([service, operations]) => !ANY_WRITE.has(service) && operations.test(operation)).map(([service]) => service),
        ...[...DENIED_WITH.keys()].filter(call => call.endsWith(` ${operation}`)).map(call => call.split(' ')[0] ?? ''),
      ]

      return services.map(service => [service, ...args])
    })
    const cli = [...invocations(text, BINARY), ...shellNamed, ...lost].map(args => mutation(args, valued)).find(Boolean)
    if (cli !== undefined) {
      return `aws ${cli}`
    }

    const viaRunner = invocations(text, RUNNER).map(args => inRunner(args, depth, valued)).find(Boolean)
    if (viaRunner !== undefined) {
      return viaRunner
    }
  }

  // The parser hands back a call's arguments, not its name, so the name is found in the text.
  // A here-string's body is a value the parser reads as words, so in a command with one a -WhatIf allows nothing.
  const hasHereString = /@["'][ \t]*\r?\n/.test(command)

  if (cmdletCalls(command, CMDLET).some(([, strict]) => hasHereString || !isWhatIf(strict))) {
    return command.match(CMDLET_IN_TEXT)?.[0] ?? 'an AWS Tools for PowerShell call'
  }

  return CMDLET_WITH.find(([name, , isDenied]) => {
    const calls = cmdletCalls(command, named(name))

    if (calls.length === 0) {
      return false
    }

    // The parser ends a call at a parenthesis (-InstanceId ($x) -Terminate), so each call the text starts is read too: every word to
    // the statement's end, and the call's own words with quotes paired and not.
    const statements = [...command.replace(/`\r?\n/g, ' ').matchAll(new RegExp(r`(?<![\w-])(${name})(?![\w-])[^;|\n]*`, 'gi'))].map(
      ([statement]) => statement.split(/[\s(){}]+/),
    )
    const starts = [...command.matchAll(new RegExp(r`(?<![\w-])(${name})(?![\w-])`, 'gi'))].map(match => (match.index ?? 0) + match[0].length)
    const written = [...statements, ...starts.slice(0, MOST).flatMap(from => [true, false].map(quotes => ownWords(command, from, quotes)))]

    // A call the text does not show by name (Stop-EC2"Instance"), or more of them than are read, is denied unread.
    return (
      starts.length === 0 ||
      starts.length > MOST ||
      [...calls, ...written.map(words => [words, words] as const)].some(
        ([args, strict]) => !isWhatIf(strict) && (isDenied(args) || isDenied(strict)),
      )
    )
  })?.[1]
}

// A call through a variable (& $c, & ($c), . $c) that the same command sets to a name: read again with the name written in its
// place, so a cmdlet denied by its arguments (Stop-EC2Instance -Terminate) is read with them. An assignment's name the parser
// already reads as a call. shortcut: a name only known at run time (& $cmd alone, a name built from parts) is not followed.
const CALL_THROUGH = /&\s*\(?\s*["']?\$|(^|[;{\n])\s*\.\s+\(?\s*["']?\$/
const ASSIGNED_NAME = /\$\{?([\w:]+)\}?\s*=\s*(["'])([\w.\\-]+)\2/g

const throughVariables = (command: string): string | undefined => {
  if (!CALL_THROUGH.test(command)) {
    return undefined
  }

  const assigned = [...command.matchAll(ASSIGNED_NAME)]

  if (assigned.length > MOST) {
    return `a call through a variable ${TOO_LONG}`
  }

  const text = assigned.reduce(
    // $c, ${c} and $C are one variable: PowerShell's names ignore case.
    (text, [, name = '', , value = '']) => text.replace(new RegExp(r`\$(\{${name}\}|${name}(?![\w:]))(?!\s*=)`, 'gi'), () => value),
    command,
  )

  return text === command ? undefined : denied(text)
}

const INTERPRETER = /(?<![\w.-])(i?python[\d.]*|py|node|deno|bun|pwsh|powershell|ruby)(\.exe)?(?=[\s"'`]|$)/gi
// An interpreter runs code from the command line: an inline-code flag, clustered or not (python -Ic, node -pe, pwsh -Command),
// deno eval, or stdin (`-`, a heredoc, a pipe into it).
// The code may be attached to the flag (-c"...", -Ic'...', node -pe'...', --eval=...), so only the flag's start is matched.
const INLINE_FLAG = /^(-\w*[cep]|--(eval|print)(=|$)|-$|eval$)/i
const SDK = /boto3|botocore|aws-sdk|AWSSDK|\bAmazon\.\w/i

const runsInlineCode = (command: string): boolean | undefined => {
  let seen = 0

  for (const match of command.matchAll(INTERPRETER)) {
    // Each one reads to its statement's end, so more than are read is denied, not read on: the work stays linear.
    if (++seen > MOST) {
      return undefined
    }

    const rest = command.slice((match.index ?? 0) + match[0].length)
    const end = rest.search(/[;|&\n]/)
    const statement = end < 0 ? rest : rest.slice(0, end)
    const isPiped = command.slice(0, match.index).trimEnd().endsWith('|')

    if (isPiped || statement.includes('<<') || statement.split(/\s+/).some(word => INLINE_FLAG.test(word))) {
      return true
    }
  }

  return false
}

// The SDKs name a CLI operation delete_role (Python), deleteRole (JavaScript v2), DeleteRoleCommand (v3) or DeleteRoleAsync (.NET);
// a boto3 resource or a client's object deletes with .delete(), .terminate() or .remove().
// Organizations and Identity Center deny every word, and configure has no SDK call, so they are left out here.
// shortcut: code on the command line or stdin, read whole once an interpreter runs some, by the deny list's operation names; a
// script file, and code built at run time, pass.
const sdkCall = (command: string): string | undefined => {
  if (!SDK.test(command)) {
    return undefined
  }

  const runs = runsInlineCode(command)

  if (runs === undefined) {
    return `inline code ${TOO_LONG}`
  }

  if (!runs) {
    return undefined
  }

  const removal = /resource\(|client\(/i.test(command) ? command.match(/\.(delete|terminate|remove)\s*\(/)?.[0] : undefined

  if (removal !== undefined) {
    return `the AWS SDK's ${removal}`
  }

  for (const [identifier] of command.matchAll(/[A-Za-z][\w]*/g)) {
    const operation = identifier
      .replace(/(Command|Async|Request)$/, '')
      .replace(/_/g, '-')
      .replace(/([a-z\d])([A-Z])/g, '$1-$2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
      .toLowerCase()
    const isDenied = (service: string, operations: RegExp) => !ANY_WRITE.has(service) && service !== 'configure' && operations.test(operation)

    if (operation.includes('-') && [...DENIED].some(([service, operations]) => isDenied(service, operations))) {
      return `the AWS SDK's ${identifier}`
    }
  }

  return undefined
}

// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
// shortcut: any other MCP tool that runs a command is not read; deny it by name in managed settings (permissions.deny) or add it here.

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: SHELL_TOOLS }, ($, e, next) => {
    // A Monitor that opens a WebSocket has no command.
    const command = String((e as { command?: unknown }).command ?? '')
    // Too long or too nested to read: denied with the parser's reason, not as a guard that failed.
    const why = unreadable(command)

    if (why !== undefined) {
      return { deny: `${$.plugin.name}: ${why}, so it is not run unread. Give the user the exact command to run themselves with the \`!\` prefix.` }
    }

    const call = denied(command) ?? throughVariables(command) ?? sdkCall(command)

    return call === undefined
      ? next(e)
      : {
          deny: `${$.plugin.name}: \`${call}\` needs the user's explicit confirmation. Give them the exact command to run themselves with the \`!\` prefix.`,
        }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
