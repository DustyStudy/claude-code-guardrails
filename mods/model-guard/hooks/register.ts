import type { Register } from 'claude-code'

import { invocations } from './shell'

// Codex runs through the plugin's companion script (node codex-companion.mjs task) or the CLI itself.
const NODE = /^(.*[\\/])?node(\.exe)?$/i
const CODEX = /^(.*[\\/])?codex(\.exe|\.cmd|\.ps1)?$/i
const COMPANION_RUN = /^(task|review|adversarial-review)$/
// The companion's reviews take --model but no --effort (review rejects it, adversarial-review reads it as focus text), so Codex's configured effort applies.
const COMPANION_REVIEW = /^(review|adversarial-review)$/
const CLI_RUN = /^(exec|e|review)$/

// The flags and values a setting asks for, each flag with the value after it, if any: --model x --effort high.
const required = (setting: string) => {
  const words = setting.split(/\s+/).filter(Boolean)

  return words.flatMap((word, i) =>
    !word.startsWith('-') ? [] : [{ flag: word, value: words[i + 1]?.startsWith('-') ? undefined : words[i + 1] }],
  )
}

// Every spelling Codex or the companion reads as the flag: -x and --x alike, and -m or --m for the model.
const spellings = (flag: string) => {
  const name = flag.replace(/^-+/, '')

  return (name === 'model' ? [name, 'm'] : [name]).flatMap(one => [`-${one}`, `--${one}`])
}

// A flag with its value as one word (--model=x) or two (--model x). The last one given wins, and words after -- are the prompt.
const has = (all: readonly string[], { flag, value }: { flag: string; value?: string }) => {
  const args = all.includes('--') ? all.slice(0, all.indexOf('--')) : all
  const names = spellings(flag)

  if (value === undefined) {
    return args.some(arg => names.includes(arg))
  }

  const given = args.flatMap((arg, i) => {
    // Only a -- spelling takes its value after =: the companion reads -m=x as prompt text.
    const inline = names.find(name => name.startsWith('--') && arg.startsWith(`${name}=`))

    return names.includes(arg) ? [args[i + 1]] : inline ? [arg.slice(inline.length + 1)] : []
  })

  return given.at(-1) === value
}

// The argument lists of the Codex runs in a command: the ones that spend the plan, not --version, --help or login.
// shortcut: a CLI run is any call with an exec, e or review word, so a flag whose value is one of those counts too; parse the CLI's options if that bites.
const codexRuns = (command: string) => [
  ...invocations(command, NODE).flatMap(all => {
    // Node's own flags come before the script, some with a value (--require node:fs), so the script is found by name.
    const at = all.findIndex(arg => /codex-companion\.mjs$/i.test(arg))
    // Code given with -e, -p or - (stdin) runs instead of a script, so a companion path after it is only an argument.
    const isCode = all.slice(0, Math.max(at, 0)).some(arg => /^(-e|--eval|-p|--print|-pe|-)(=|$)/.test(arg))
    const args = at < 0 || isCode ? [] : all.slice(at)

    return COMPANION_RUN.test(args[1] ?? '')
      ? [{ args: args.slice(2), takesEffort: !COMPANION_REVIEW.test(args[1] ?? '') }]
      : []
  }),
  ...invocations(command, CODEX)
    .filter(args => args.some(arg => CLI_RUN.test(arg)) && !args.some(arg => /^(-h|--help|help)$/.test(arg)))
    .map(args => ({ args, takesEffort: true })),
]

export const register: Register = on => {
  // Rewrites rather than denies: the subagent starts on the right model, with no retry.
  on('agent.spawn', async ($, e, next) => {
    const model = (await $.env.get('MODEL_GUARD_SUBAGENT_MODEL'))?.trim()

    // A fork always runs on the parent's model, whatever the call says.
    return next(model && e.subagentType !== 'fork' && e.model !== model ? { ...e, model } : e)
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const setting = (await $.env.get('MODEL_GUARD_CODEX_ARGS'))?.trim() ?? ''
    const wanted = required(setting)
    const missing = codexRuns(e.command).flatMap(({ args, takesEffort }) =>
      wanted.filter(one => (takesEffort || one.flag !== '--effort') && !has(args, one)),
    )

    if (missing.length > 0) {
      const names = [...new Set(missing.map(({ flag, value }) => (value === undefined ? flag : `${flag} ${value}`)))]

      return { deny: `${$.plugin.name}: every Codex run here takes ${setting}; this one is missing ${names.join(' and ')}. Add it and run again.` }
    }

    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))
}
