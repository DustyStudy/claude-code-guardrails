import type { Register } from 'claude-code'

import { DYNAMIC, invocations, unreadable } from './shell'

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
// The three spellings Terraform's CLI takes for help, wherever they stand before a `--`. `--h` is not one: after -backup it is a file name.
const HELP = /^(-h|-help|--help)$/
// Where the words Terraform reads for help end: its own `--`, and the ; or + that ends find's -exec (the rest is find's).
const STOP = /^(--|;|\+)$/
// A word the shell fills in, wholly ($(x), marked DYNAMIC) or in part ("$(x)"). A flag's quoted value (-chdir="$(pwd)") stays that
// flag, when the rest of the word is plain: a ${ } or brace beside it can split it into words (-chdir=${x:-"}"$(y)"}").
const isUnread = (word: string) => word.includes('\0') && !/^--?[\w-]+=[\w./:\\-]*\0[\w ./:\\-]*$/.test(word)
// Terraform also takes flags from TF_CLI_ARGS and TF_CLI_ARGS_<verb>: set on the command line, or inherited (passed in as `inherited`).
// However it is set: VAR=, $env:VAR +=, [Environment]::SetEnvironmentVariable('VAR', ...).
// The rest of the command that sets one, quoted runs whole: a ; & or | inside the quotes is part of the value (-var=a=b&c -auto-approve).
// An escaped character is part of the value too (\;\ -auto-approve), whichever shell's escape it is.
const SET = /TF_CLI_ARGS\w*(?:[\\`^]\r?[\s\S]|"[^"]*"|'[^']*'|[^;&|\n])*/gi
const APPROVES = /-auto-approve(?!=(0|f|false)\b)/i
// The value as the shell hands it on: quotes, escapes and line continuations gone (-auto-appr\ove, -auto-"approve").
const cooked = (set: string) => set.replace(/[\\`^]\r?\n/g, '').replace(/["'\\`^]/g, '')
// What the shell fills in or expands is not read: $FLAGS, $(...), $'\x2d...', ` `, and env TF_CLI_ARGS=-auto-{,approve}.
// shortcut: the whole command that sets it is searched, so TF_CLI_ARGS=-no-color terraform apply $PLAN is denied too; read only the value if that bites.
const FILLED = /[$`{]/
// Terragrunt's apply-all and destroy-all, and the ways it runs every unit, where it adds -auto-approve itself.
const VERB = /^(apply|destroy)(-all)?$/
const EVERY_UNIT = /^(run-all|graph|stack|--all|-a|--graph|destroy-all)$/
// An answer fed to destroy's prompt approves it: a pipe before it, or its input redirected.
const PIPE = /(?<![|>])\|(?!\|)/g
const DESTROY = /(?<![\w.-])destroy(?![\w.-])/g
// The one pipeline known to end before the destroy: right after the pipe a command of plain words (no quote, escape, $, brace,
// parenthesis or comment), not a keyword that opens a loop or a group, then a ; or a newline (git log | head; terraform destroy).
// shortcut: every other pipe before a destroy counts as feeding it (yes | cd stack && terraform destroy); widen it only with a hostile review.
const ENDS = /[ \t]*(?!(?:while|until|if|for|case|select|do|then|else|elif|time|coproc|function|exec)\b)[\w./:=@%+,~-][\w \t./:=@%+,~-]*[;\n]/y

// Each pipe is read once from where it stands, not the rest of the command from every pipe.
const isFed = (command: string) => {
  const lastDestroy = [...command.matchAll(DESTROY)].at(-1)?.index ?? -1

  return (
    command.includes('<') ||
    [...command.matchAll(PIPE)].some(pipe => {
      ENDS.lastIndex = pipe.index + 1
      const plain = ENDS.exec(command)

      return pipe.index < lastDestroy && (plain === null || plain[0].search(DESTROY) >= 0)
    })
  )
}

// Every call of a terraform program: named itself, or after a launcher, whose quoted argument (npx -c "terraform ...") is split into words.
// The arguments stay in place, DYNAMIC where the shell fills one in; one that stood before the program is put last.
const calls = (command: string) => [
  ...invocations(command, BINARY, true),
  ...invocations(command, LAUNCHER, true).flatMap(args => {
    const words = args.flatMap(word => word.split(/\s+/)).filter(Boolean)
    const at = words.findIndex(word => BINARY.test(word))

    return at < 0 ? [] : [[...words.slice(at + 1), ...(words.slice(0, at).some(isUnread) ? [DYNAMIC] : [])]]
  }),
]

type Inherited = { all?: string; apply?: string; destroy?: string }

const refusal = (command: string, env: Inherited = {}): string | undefined => {
  const unread = unreadable(command)

  if (unread !== undefined) {
    return `${unread}, so it is not run. Write it more simply.`
  }

  const sets = command.match(SET) ?? []
  const isInjected = sets.some(set => APPROVES.test(cooked(set)))

  for (const args of calls(command)) {
    const verbAt = args.findIndex(word => VERB.test(word))
    // What is written before the first word the shell fills in: only that much is known to be where it looks.
    const unreadAt = args.findIndex(isUnread)
    const head = unreadAt < 0 ? args : args.slice(0, unreadAt)
    const stopAt = head.findIndex(word => STOP.test(word))

    // Help changes nothing; another subcommand first means apply is its argument.
    if (head.slice(0, stopAt < 0 ? undefined : stopAt).some(word => HELP.test(word)) || OTHER_VERB.test(positional(head)[0] ?? '')) {
      continue
    }

    // The shell fills in words this guard cannot read: -auto-approve on an apply or destroy, or the verb itself with a flag that takes
    // the written subcommand as its value (terraform $(echo destroy -auto-approve -backup) plan).
    if (unreadAt >= 0 && (verbAt >= 0 || !positional(head).some(word => OTHER_VERB.test(word)))) {
      return `a $( ), backtick, ( ) or brace sequence among the arguments can add -auto-approve to an apply or destroy. Write the arguments out. ${HOW}`
    }

    if (verbAt < 0) {
      continue
    }

    if (sets.some(set => FILLED.test(set))) {
      return `TF_CLI_ARGS is set from a $, backtick or brace the shell fills in, which can add -auto-approve to ${args[verbAt]}. Write its value out. ${HOW}`
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
