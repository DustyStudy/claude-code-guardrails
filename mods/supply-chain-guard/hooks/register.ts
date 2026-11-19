import type { Register } from 'claude-code'

import { invocations } from './shell'

const bin = (name: string) => new RegExp(String.raw`^(.*[\\/])?${name}(\.exe|\.cmd)?$`, 'i')
const PIP = bin('pip3?')
const UV = bin('uv')
const JS = bin('(npm|pnpm|yarn|bun)')
const PYTHON = bin('python3?')

// Global options that take a value, which is not the verb.
const VALUE_OPTION =
  /^--(prefix|registry|userconfig|workspace|cache|tag|cwd|dir|index-url|extra-index-url|proxy|python|log|cache-dir|target)$/
const words = (args: readonly string[]) =>
  args.filter((word, i) => !word.startsWith('-') && !VALUE_OPTION.test(args[i - 1] ?? ''))

// A package named on the command line comes from the registry as it is today, not from a lockfile.
const jsAdds = (args: readonly string[]) => {
  const [verb, ...packages] = words(args)

  return /^(install|i|add)$/.test(verb ?? '') && packages.length > 0
}
// Hashes are the pip check; -e is a local path and --help only prints.
const pipUnpinned = (args: readonly string[]) =>
  words(args)[0] === 'install' && !args.some(arg => /^(--require-hashes|-e|--editable|-h|--help)$/.test(arg))
const uvUnpinned = (args: readonly string[]) => {
  const [verb, ...rest] = words(args)

  return verb === 'pip' ? pipUnpinned(args.slice(args.indexOf('pip') + 1)) : verb === 'add' && rest.length > 0
}

// shortcut: the install verbs of pip, uv, npm, pnpm, yarn and bun; poetry, conda and go get pass, and a script that installs is not read. Upgrade if those come into use.
const unpinned = (command: string): string | undefined => {
  const checks: [RegExp, (args: readonly string[]) => boolean, string][] = [
    [PIP, pipUnpinned, 'pip'],
    [UV, uvUnpinned, 'uv'],
    [JS, jsAdds, 'a package manager'],
  ]
  const named = checks.find(([binary, check]) => invocations(command, binary).some(check))?.[2]
  // python -m pip install: pip's arguments follow -m pip.
  const viaPython = invocations(command, PYTHON).some(
    args => args[0] === '-m' && args[1] === 'pip' && pipUnpinned(args.slice(2)),
  )

  return named ?? (viaPython ? 'pip' : undefined)
}

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, ($, e, next) => {
    const manager = unpinned(e.command)

    return manager === undefined
      ? next(e)
      : {
          deny: `${$.plugin.name}: \`${manager}\` would install a package no lockfile or hash pins. Install from the lockfile (npm ci, pip install --require-hashes -r), or give the user the exact command to run themselves with the \`!\` prefix.`,
        }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
