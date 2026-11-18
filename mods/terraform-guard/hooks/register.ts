import type { Register } from 'claude-code'

import { invocations } from './shell'

const BINARY = /^(.*[\\/])?(terraform|tofu|terragrunt)(\.exe)?$/i
// Flags that stand alone. Any other flag written without `=` takes the next word as its value (-var-file prod.tfvars,
// --working-dir live), which must not pass for a plan file or a subcommand.
const BARE_FLAG =
  /^--?(no-color|json|compact-warnings|concise|show-sensitive|destroy|refresh-only|input|lock|refresh|non-interactive|terragrunt-non-interactive|all|a|graph)$/
const positional = (args: readonly string[]) =>
  args.filter((word, i) => !word.startsWith('-') && !(/^-[^=]*$/.test(args[i - 1] ?? '') && !BARE_FLAG.test(args[i - 1] ?? '')))
const HOW = 'Run `terraform plan -out=tfplan`, review it, then `terraform apply tfplan`.'

// Subcommands that take `apply` or `destroy` only as a value (`terraform output apply`, `state show destroy`).
const OTHER_VERB =
  /^(output|show|state|console|fmt|validate|providers|workspace|import|init|plan|version|get|login|logout|taint|untaint|force-unlock|test|metadata|modules|refresh)$/
const HELP = /^--?h(elp)?$/
// Terraform also takes flags from TF_CLI_ARGS and TF_CLI_ARGS_<verb>: set on the command line, or inherited (passed in as `inherited`).
// However it is set: VAR=, $env:VAR +=, [Environment]::SetEnvironmentVariable('VAR', ...).
const INJECTED = /TF_CLI_ARGS\w*[^;&|\n]*-auto-approve(?!=(0|f|false)\b)/i
// Terragrunt's apply-all and destroy-all, and the ways it runs every unit, where it adds -auto-approve itself.
const VERB = /^(apply|destroy)(-all)?$/
const EVERY_UNIT = /^(run-all|graph|stack|--all|-a|--graph|destroy-all)$/
// An answer fed to destroy's prompt approves it: a pipe before it, or its input redirected.
const FED = /(?<!\|)\|(?!\|)[\s\S]*(?<![\w.-])destroy(?![\w.-])|</

type Inherited = { all?: string; apply?: string; destroy?: string }

const refusal = (command: string, env: Inherited = {}): string | undefined => {
  for (const args of invocations(command, BINARY)) {
    const verbAt = args.findIndex(word => VERB.test(word))
    const [first] = positional(args)

    // Help changes nothing; another subcommand first means apply is its argument.
    if (verbAt < 0 || args.some(word => HELP.test(word)) || OTHER_VERB.test(first ?? '')) {
      continue
    }

    const rest = args.slice(verbAt + 1)
    const verb = args[verbAt]?.startsWith('apply') ? 'apply' : 'destroy'
    const inherited = `${env.all ?? ''} ${env[verb] ?? ''}`.split(/\s+/).filter(Boolean)

    // Terraform reads =1, =t, =TRUE as true too, so only an explicit false passes.
    if (INJECTED.test(command) || [...args, ...inherited].some(word => /^--?auto-approve(=.*)?$/.test(word) && !/=(0|f|false)$/i.test(word))) {
      return `-auto-approve is not allowed on ${args[verbAt]}. ${HOW}`
    }

    if (verb === 'destroy' && [...positional(args), ...args.filter(word => word.startsWith('-'))].some(word => EVERY_UNIT.test(word)) && !args.some(word => /^--(terragrunt-)?no-auto-approve$/.test(word))) {
      return `terragrunt adds -auto-approve to a destroy of every unit. Pass --no-auto-approve, or: ${HOW}`
    }

    if (verb === 'destroy' && FED.test(command)) {
      return `destroy takes its approval from the user, not from a pipe or a file. Run it on its own, or: ${HOW}`
    }

    if (verb === 'apply' && positional(rest).length === 0) {
      return `apply needs a saved plan file. ${HOW}`
    }
  }

  return undefined
}

// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
// shortcut: any other MCP tool that runs a command is not read; deny it by name in managed settings (permissions.deny) or add it here.

export const register: Register = on => {
  on('tool.call', { tool: SHELL_TOOLS }, async ($, e, next) => {
    // A Monitor that opens a WebSocket has no command.
    const command = String((e as { command?: unknown }).command ?? '')
    const why = refusal(command, {
      all: await $.env.get('TF_CLI_ARGS'),
      apply: await $.env.get('TF_CLI_ARGS_apply'),
      destroy: await $.env.get('TF_CLI_ARGS_destroy'),
    })

    return why ? { deny: `${$.plugin.name}: ${why}` } : next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
