import type { Register } from 'claude-code'

// Commands whose output is long and mostly progress: inits, plans and applies, scanners, installs, image builds.
const NOISY =
  /(^|[\s;&|(`'"])((terraform|tofu)(\.exe)?\s+(-\S+\s+)*(init|plan|apply|destroy|import|refresh|providers)\b|(checkov|prowler|trivy|tfsec)\b|(npm|pnpm|yarn|bun)\s+(install|ci|i|add|update)\b|(pip3?|uv|poetry)\s+(\S+\s+)?(install|sync|add|lock)\b|docker\s+(build|pull|compose\s+(build|pull|up))\b|scoop\s+(install|update)\b|winget\s+(install|upgrade)\b)/i
// Output up to this many lines is kept whole.
const MAX_LINES = 120
const HEAD = 15
const TAIL = 40
const MAX_FLAGGED = 30
// Lines worth keeping from the cut middle: what failed and what warned.
const FLAGGED = /\b(error|errors|fail|failed|failure|denied|fatal|panic|exception|warn|warning)\b|✗/i

/** The head, the flagged lines of the middle and the tail of a long output; undefined when it is kept whole. */
export const trim = (text: string, path: string): string | undefined => {
  const lines = text.split('\n')

  if (lines.length <= MAX_LINES) {
    return undefined
  }

  const middle = lines.slice(HEAD, -TAIL)
  const flagged = middle.filter(line => FLAGGED.test(line))
  const kept = flagged.slice(0, MAX_FLAGGED)

  return [
    ...lines.slice(0, HEAD),
    `[output-trimmer: ${middle.length} lines cut${kept.length > 0 ? `, the ${kept.length} error or warning lines among them kept below` : ''}. Full output: ${path}]`,
    ...kept,
    ...(flagged.length > kept.length ? [`[+ ${flagged.length - kept.length} more error or warning lines in the file]`] : []),
    '[...]',
    ...lines.slice(-TAIL),
  ].join('\n')
}

export const register: Register = on => {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const done = await next(e)

    if (done.result === undefined || !NOISY.test(e.command)) {
      return done
    }

    // shortcut: the files are left to the OS temp cleanup; prune them here if the folder ever grows large.
    const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
    // The path the model is told reads as its platform writes it.
    const sep = temp.includes('\\') ? '\\' : '/'
    const path = [temp, 'claude-output', `${Date.now()}-${e.tool_use_id}.log`].join(sep)
    const { stdout, stderr } = done.result as { stdout?: unknown; stderr?: unknown }

    if (typeof stdout !== 'string' || typeof stderr !== 'string') {
      return done
    }

    const out = trim(stdout, path)
    const err = trim(stderr, path)

    if (out === undefined && err === undefined) {
      return done
    }

    // Nothing is cut that is not saved first: a failed write hands the model the whole output.
    try {
      await $.fs.write(path, `$ ${e.command}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`)
    } catch {
      return done
    }

    // A new result, so no ref; other hooks' reminders to the model stay.
    return {
      result: { ...(done.result as object), stdout: out ?? stdout, stderr: err ?? stderr },
      ...(done.context === undefined ? {} : { context: done.context }),
    }
  })
}
