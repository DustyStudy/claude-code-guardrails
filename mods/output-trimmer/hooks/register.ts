import type { EngineInterface, Register } from 'claude-code'

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
// Saved logs older than this are emptied: they can hold plan values and are only read within a session or two.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

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

// shortcut: the host has no file delete, so an old log is emptied and its 0-byte file stays; delete the folder by hand if the count ever matters.
const prune = async ($: EngineInterface, dir: string, sep: string, cutoff: number, keep: string) => {
  // A linked folder could point the sweep at files that are not this mod's.
  if ((await $.fs.stat(dir)).isLink) {
    return
  }

  for (const entry of await $.fs.list(dir)) {
    if (entry.kind === 'file' && entry.name.endsWith('.log') && entry.name !== keep && entry.size > 0 && entry.mtimeMs < cutoff) {
      // One log that cannot be written must not stop the rest.
      await $.fs.write(dir + sep + entry.name, '').catch(() => undefined)
    }
  }
}

export const register: Register = on => {
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const done = await next(e)

    if (done.result === undefined || !NOISY.test(e.command)) {
      return done
    }

    const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
    // The path the model is told reads as its platform writes it.
    const sep = temp.includes('\\') ? '\\' : '/'
    const dir = [temp, 'claude-output'].join(sep)
    const now = Date.now()
    const name = `${now}-${e.tool_use_id}.log`
    const path = [dir, name].join(sep)
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

    // Best effort: a failed prune never costs the model its result.
    await prune($, dir, sep, now - KEEP_MS, name).catch(() => undefined)

    // A new result, so no ref; other hooks' reminders to the model stay.
    return {
      result: { ...(done.result as object), stdout: out ?? stdout, stderr: err ?? stderr },
      ...(done.context === undefined ? {} : { context: done.context }),
    }
  })
}
