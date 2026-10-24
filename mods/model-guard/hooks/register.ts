import type { Register } from 'claude-code'

import { invocations } from './shell'

// Codex runs through the plugin's companion script (node codex-companion.mjs task) or the CLI itself.
const NODE = /^(.*[\\/])?node(\.exe)?$/i
const CODEX = /^(.*[\\/])?codex(\.exe|\.cmd|\.ps1)?$/i
const COMPANION_RUN = /^(task|review|adversarial-review)$/
const CLI_RUN = /^(exec|e|review)$/

// The flags and values a setting asks for, each flag with the value after it, if any: --model x --effort high.
const required = (setting: string) => {
  const words = setting.split(/\s+/).filter(Boolean)

  return words.flatMap((word, i) =>
    !word.startsWith('-') ? [] : [{ flag: word, value: words[i + 1]?.startsWith('-') ? undefined : words[i + 1] }],
  )
}

// A flag with its value as one word (--model=x) or two (--model x). The last one given wins, and words after -- are the prompt.
const has = (all: readonly string[], { flag, value }: { flag: string; value?: string }) => {
  const args = all.includes('--') ? all.slice(0, all.indexOf('--')) : all

  if (value === undefined) {
    return args.includes(flag)
  }

  const given = args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : []))

  return given.at(-1) === value
}

// The argument lists of the Codex runs in a command: the ones that spend the plan, not --version, --help or login.
// shortcut: a CLI run is any call with an exec, e or review word, so a flag whose value is one of those counts too; parse the CLI's options if that bites.
const codexRuns = (command: string) => [
  ...invocations(command, NODE).flatMap(all => {
    // Node's own flags (--no-warnings) come before the script.
    const args = all.slice(all.findIndex(arg => !arg.startsWith('-')))

    return /codex-companion\.mjs$/i.test(args[0] ?? '') && COMPANION_RUN.test(args[1] ?? '') ? [args.slice(2)] : []
  }),
  ...invocations(command, CODEX).filter(
    args => args.some(arg => CLI_RUN.test(arg)) && !args.some(arg => /^(-h|--help|help)$/.test(arg)),
  ),
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
    const missing = codexRuns(e.command).flatMap(args => wanted.filter(one => !has(args, one)))

    if (missing.length > 0) {
      const names = [...new Set(missing.map(({ flag, value }) => (value === undefined ? flag : `${flag} ${value}`)))]

      return { deny: `${$.plugin.name}: every Codex run here takes ${setting}; this one is missing ${names.join(' and ')}. Add it and run again.` }
    }

    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))
}
