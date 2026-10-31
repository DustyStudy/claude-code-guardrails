import type { Register } from 'claude-code'

import { invocations } from './shell'

const BINARY = /^(.*[\\/])?(terraform|tofu|terragrunt)(\.exe)?$/i
// Flags whose value can be the next word, which must not pass for a plan file.
const VALUE_FLAG =
  /^--?(var|var-file|target|replace|parallelism|lock-timeout|state|state-out|backup)$/
const HOW = 'Run `terraform plan -out=tfplan`, review it, then `terraform apply tfplan`.'

// Subcommands that take `apply` or `destroy` only as a value (`terraform output apply`, `state show destroy`).
const OTHER_VERB =
  /^(output|show|state|console|fmt|validate|providers|workspace|graph|import|init|plan|version|get|login|logout|taint|untaint|force-unlock|test|metadata|modules|refresh)$/
const HELP = /^--?h(elp)?$/
// Terraform also takes flags from TF_CLI_ARGS and TF_CLI_ARGS_<verb>: set on the command line, or inherited (passed in as `inherited`).
const INJECTED = /TF_CLI_ARGS\w*\s*=\s*["']?[^;&|\n]*-auto-approve(?!=(0|f|false)\b)/i

type Inherited = { all?: string; apply?: string; destroy?: string }

const refusal = (command: string, env: Inherited = {}): string | undefined => {
  for (const args of invocations(command, BINARY)) {
    const verbAt = args.findIndex(word => word === 'apply' || word === 'destroy')
    const first = args.find(word => !word.startsWith('-'))

    // Help changes nothing; another subcommand first means apply is its argument.
    if (verbAt < 0 || args.some(word => HELP.test(word)) || OTHER_VERB.test(first ?? '')) {
      continue
    }

    const rest = args.slice(verbAt + 1)
    const verb = args[verbAt] === 'apply' ? 'apply' : 'destroy'
    const inherited = `${env.all ?? ''} ${env[verb] ?? ''}`.split(/\s+/).filter(Boolean)

    // Terraform reads =1, =t, =TRUE as true too, so only an explicit false passes.
    if (INJECTED.test(command) || [...args, ...inherited].some(word => /^--?auto-approve(=.*)?$/.test(word) && !/=(0|f|false)$/i.test(word))) {
      return `-auto-approve is not allowed on ${args[verbAt]}. ${HOW}`
    }

    const hasPlan = rest.some(
      (word, i) => !word.startsWith('-') && !VALUE_FLAG.test(rest[i - 1] ?? ''),
    )

    if (args[verbAt] === 'apply' && !hasPlan) {
      return `apply needs a saved plan file. ${HOW}`
    }
  }

  return undefined
}

export const register: Register = on => {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const why = refusal(e.command, {
      all: await $.env.get('TF_CLI_ARGS'),
      apply: await $.env.get('TF_CLI_ARGS_apply'),
      destroy: await $.env.get('TF_CLI_ARGS_destroy'),
    })

    return why ? { deny: `${$.plugin.name}: ${why}` } : next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
