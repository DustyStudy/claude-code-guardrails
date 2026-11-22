import type { Register } from 'claude-code'

import { DYNAMIC, invocations } from './shell'

const BINARY = /^(.*[\\/])?(terraform|tofu|terragrunt)(\.(exe|cmd|bat))?$/i
// Programs that run the one named after them and are not among the shared parser's wrappers: a shell's builtin and noglob, and the
// package runners (npx terraform, pnpm dlx terraform, yarn dlx tofu, uvx terragrunt).
const LAUNCHER = /^(.*[\\/])?(builtin|noglob|npx|bunx|pnpm|yarn|uvx)(\.(exe|cmd|bat))?$/i
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
// The rest of the command that sets one, quoted runs whole: a ; & or | inside the quotes is part of the value (-var=a=b&c -auto-approve).
const SET = /TF_CLI_ARGS\w*(?:"[^"]*"|'[^']*'|[^;&|\n])*/gi
const APPROVES = /-auto-approve(?!=(0|f|false)\b)/i
// Terragrunt's apply-all and destroy-all, and the ways it runs every unit, where it adds -auto-approve itself.
const VERB = /^(apply|destroy)(-all)?$/
const EVERY_UNIT = /^(run-all|graph|stack|--all|-a|--graph|destroy-all)$/
// An answer fed to destroy's prompt approves it: a pipe before it, or its input redirected.
// shortcut: any pipe earlier in the command counts, one that ends before the destroy too (git log | head; terraform destroy). Telling those
// apart needs the pipeline's real extent (yes |\n terraform destroy, yes | while ...; do terraform destroy; done): narrow it only with a hostile review.
const PIPE = /(?<!\|)\|(?!\|)/
const DESTROY = /(?<![\w.-])destroy(?![\w.-])/

// Two single passes, not one pattern that rescans the rest of the command from every pipe.
const isFed = (command: string) => {
  const pipeAt = command.search(PIPE)

  return command.includes('<') || (pipeAt >= 0 && DESTROY.test(command.slice(pipeAt)))
}

// Every call of a terraform program: named itself, or after a launcher, whose quoted argument (npx -c "terraform ...") is split into words.
const calls = (command: string) => [
  ...invocations(command, BINARY),
  ...invocations(command, LAUNCHER).flatMap(args => {
    const words = args.flatMap(word => word.split(/\s+/)).filter(Boolean)
    const at = words.findIndex(word => BINARY.test(word))

    return at < 0 ? [] : [words.slice(at + 1)]
  }),
]

type Inherited = { all?: string; apply?: string; destroy?: string }

const refusal = (command: string, env: Inherited = {}): string | undefined => {
  const isInjected = (command.match(SET) ?? []).some(set => APPROVES.test(set))

  for (const args of calls(command)) {
    const verbAt = args.findIndex(word => VERB.test(word))
    const [first] = positional(args)

    // Help changes nothing; another subcommand first means apply is its argument.
    if (args.some(word => HELP.test(word)) || OTHER_VERB.test(first ?? '')) {
      continue
    }

    // The shell fills in words this guard cannot read: -auto-approve on an apply or destroy, or the verb itself (terraform $(echo destroy ...)).
    if (args.includes(DYNAMIC) && (verbAt >= 0 || !positional(args).some(word => OTHER_VERB.test(word)))) {
      return `a $( ), backtick or ( ) among the arguments can add -auto-approve to an apply or destroy. Write the arguments out. ${HOW}`
    }

    if (verbAt < 0) {
      continue
    }

    const rest = args.slice(verbAt + 1)
    const verb = args[verbAt]?.startsWith('apply') ? 'apply' : 'destroy'
    // Terraform splits the value like a shell does, so a quoted flag is the flag.
    const inherited = `${env.all ?? ''} ${env[verb] ?? ''}`.replace(/["']/g, '').split(/\s+/).filter(Boolean)

    // Terraform reads =1, =t, =TRUE as true too, so only an explicit false passes.
    if (isInjected ||[...args, ...inherited].some(word => /^--?auto-approve(=.*)?$/.test(word) && !/=(0|f|false)$/i.test(word))) {
      return `-auto-approve is not allowed on ${args[verbAt]}. ${HOW}`
    }

    if (verb === 'destroy' && [...positional(args), ...args.filter(word => word.startsWith('-'))].some(word => EVERY_UNIT.test(word)) && !args.some(word => /^--(terragrunt-)?no-auto-approve$/.test(word))) {
      return `terragrunt adds -auto-approve to a destroy of every unit. Pass --no-auto-approve, or: ${HOW}`
    }

    if (verb === 'destroy' && isFed(command)) {
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
