import type { Register } from 'claude-code'

import { invocations } from './shell'

const BINARY = /^(.*[\\/])?aws(\.exe)?$/i
// Global options that take a value, which is not the service or the operation.
const VALUE_OPTION =
  /^--(profile|region|output|endpoint-url|query|color|ca-bundle|cli-read-timeout|cli-connect-timeout|cli-binary-format)$/
// shortcut: the AWS CLI and AWS Tools for PowerShell; SDK scripts and cmdlets called through a variable pass, upgrade if those come into use.
const MUTATION =
  /^(iam delete-(role|policy)[\w-]*|organizations (?!describe-|list-|help$)[a-z][\w-]*|kms (schedule-key-deletion|delete-imported-key-material))$/
// The AWS Tools for PowerShell cmdlets for the same calls, module-qualified or not: any Organizations verb but Get.
// ORG is the AWS noun prefix (Move-ORGAccount, New-ORGOrganization); Exchange's Remove-OrganizationRelationship is not one.
const CMDLET_NAME = String.raw`(Remove-IAM(Role|Policy)\w*|(?!Get-)[a-z]+-ORG(?!aniz)\w+|Request-KMSKeyDeletion|Remove-KMSImportedKeyMaterial)`
const CMDLET = new RegExp(String.raw`^([\w.]+\\)?${CMDLET_NAME}$`, 'i')
const CMDLET_IN_TEXT = new RegExp(String.raw`(?<![\w-])${CMDLET_NAME}(?![\w-])`, 'i')

// The service and operation are the first two bare words, wherever the global options sit.
const mutation = (args: readonly string[]): string | undefined => {
  const [service, operation, next] = args.filter(
    (word, i) => !word.startsWith('-') && !VALUE_OPTION.test(args[i - 1] ?? ''),
  )
  const call = `${service} ${operation}`
  // `help` and a skeleton only print: nothing is called.
  const isDryRun = next === 'help' || args.includes('--generate-cli-skeleton')

  return operation !== undefined && !isDryRun && MUTATION.test(call) ? call : undefined
}

// -WhatIf only says what the cmdlet would do.
const isWhatIf = (args: readonly string[]) => args.some(arg => /^-WhatIf(:\$true)?$/i.test(arg))

// The call to name in the deny: the CLI's service and operation, or the cmdlet as written.
const denied = (command: string): string | undefined => {
  const cli = invocations(command, BINARY).map(mutation).find(Boolean)
  if (cli !== undefined) {
    return `aws ${cli}`
  }
  // The parser hands back a call's arguments, not its name, so the name is found in the text.
  const isCmdlet = invocations(command, CMDLET).some(args => !isWhatIf(args))

  return isCmdlet ? (command.match(CMDLET_IN_TEXT)?.[0] ?? 'an AWS Tools for PowerShell call') : undefined
}

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, ($, e, next) => {
    const call = denied(e.command)

    return call === undefined
      ? next(e)
      : {
          deny: `${$.plugin.name}: \`${call}\` needs the user's explicit confirmation. Give them the exact command to run themselves with the \`!\` prefix.`,
        }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
