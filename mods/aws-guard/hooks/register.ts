import type { Register } from 'claude-code'

import { invocations } from './shell'

const BINARY = /^(.*[\\/])?aws(\.exe)?$/i
// Global options that take a value, which is not the service or the operation.
const VALUE_OPTION =
  /^--(profile|region|output|endpoint-url|query|color|ca-bundle|cli-read-timeout|cli-connect-timeout|cli-binary-format)$/
// shortcut: AWS CLI only; AWS Tools for PowerShell cmdlets (Remove-IAMRole) and SDK scripts pass, upgrade if those come into use.
const MUTATION =
  /^(iam delete-(role|policy)[\w-]*|organizations (?!describe-|list-|help$)[a-z][\w-]*|kms (schedule-key-deletion|delete-imported-key-material))$/

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

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, ($, e, next) => {
    const call = invocations(e.command, BINARY).map(mutation).find(Boolean)

    return call === undefined
      ? next(e)
      : {
          deny: `${$.plugin.name}: \`aws ${call}\` needs the user's explicit confirmation. Give them the exact command to run themselves with the \`!\` prefix.`,
        }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
