import type { Register } from 'claude-code'

import { invocations } from './shell'

const BINARY = /^(.*[\\/])?(terraform|tofu)(\.exe)?$/i

// A real call to the subcommand: prose that names it clears nothing.
const ran = (command: string, verb: string) =>
  invocations(command, BINARY).some(args => args.find(word => !word.startsWith('-')) === verb)

export const register: Register = on => {
  // shortcut: one pair of flags for the session, not per directory; a fmt in one stack clears an edit in another, upgrade if multi-stack turns hide misses.
  let needsFmt = false
  let needsValidate = false

  const pending = () =>
    [needsFmt && 'fmt', needsValidate && 'validate'].filter(Boolean).join(' and ')

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const done = await next(e)

    if (done.deny === undefined && done.isError !== true && /\.tf$/i.test(e.file_path)) {
      needsFmt = true
      needsValidate = true
    }

    return done
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const done = await next(e)

    if (done.deny === undefined && done.isError !== true) {
      needsFmt &&= !ran(e.command, 'fmt')
      needsValidate &&= !ran(e.command, 'validate')
    }

    return done
  })

  on('turn.complete', ($, e, next) => {
    const left = pending()

    $.ui.status(left === '' ? undefined : `terraform ${left} not run since the last .tf edit`)

    return next(e)
  })
}
