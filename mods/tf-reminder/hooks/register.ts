import type { Register } from 'claude-code'

import { invocations } from './shell'

const BINARY = /^(.*[\\/])?(terraform|tofu)(\.exe)?$/i
const ABSOLUTE = /^([a-zA-Z]:)?\//
// shortcut: only a leading `cd <dir>` moves the command; a cd later in the line, pushd or Set-Location do not, upgrade if those come into use.
const CD = /^\s*cd\s+["']?([^"';&|\n]+?)["']?\s*(?:&&|;|\n)/
// A target the line fills in when it runs ({} of find and xargs, a variable): it could be any folder.
const UNKNOWN = /[{}$%]/

// One spelling per folder: forward slashes, a Git Bash /c/ as c:, a lower-case drive, no . or .. or trailing slash.
const normal = (path: string) => {
  const parts: string[] = []

  for (const part of path.replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/').split('/')) {
    if (part === '..') {
      parts.length > 1 && parts.pop()
    } else if (part !== '.' && (part !== '' || parts.length === 0)) {
      parts.push(part)
    }
  }

  // [''] is the root; [] is a relative path that went nowhere, the folder it started in.
  const joined = parts.join('/').replace(/^[A-Z]:/, drive => drive.toLowerCase())

  return joined !== '' ? joined : parts.length > 0 ? '/' : '.'
}

const resolve = (base: string, path: string) => normal(ABSOLUTE.test(normal(path)) ? path : `${base}/${path}`)

const folderOf = (file: string) => (/[\\/]/.test(file) ? file.replace(/[\\/][^\\/]*$/, '') || '/' : '.')

const isInside = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`)

/** The folders a command's fmt and validate calls cover: `[folder, includes subfolders]` each. */
export const covered = (command: string, cwd: string) => {
  const base = resolve(cwd, CD.exec(command)?.[1] ?? '.')
  const fmt: [string, boolean][] = []
  const validate: [string, boolean][] = []

  // The parser reads braces as a group, so find's and xargs' {} would vanish: it goes in as a word UNKNOWN matches.
  for (const args of invocations(command.replace(/\{\}/g, '%placeholder%'), BINARY)) {
    const chdir = args.find(arg => /^-chdir=/.test(arg))?.slice('-chdir='.length)
    const dir = chdir === undefined ? base : UNKNOWN.test(chdir) ? undefined : resolve(base, chdir)
    const [verb, ...rest] = args.filter(arg => !arg.startsWith('-'))

    if (verb === 'validate') {
      validate.push(dir === undefined ? [base, true] : [dir, false])
    } else if (verb === 'fmt') {
      const isRecursive = args.includes('-recursive')
      const targets = rest.length === 0 ? [undefined] : rest

      for (const target of targets) {
        if (dir === undefined || (target !== undefined && UNKNOWN.test(target))) {
          // Filled in at run time: taken as the whole tree it runs in.
          fmt.push([dir ?? base, true])
        } else {
          const path = target === undefined ? dir : resolve(dir, target)
          fmt.push(/\.tf(vars)?$/i.test(path) ? [folderOf(path), false] : [path, isRecursive])
        }
      }
    }
  }

  return { fmt, validate }
}

export const register: Register = on => {
  // The folders with a .tf edit that fmt and validate have not covered since.
  const needsFmt = new Set<string>()
  const needsValidate = new Set<string>()

  const clear = (pending: Set<string>, runs: [string, boolean][]) => {
    for (const dir of pending) {
      if (runs.some(([root, isTree]) => (isTree ? isInside(dir, root) : dir === root))) {
        pending.delete(dir)
      }
    }
  }

  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    const done = await next(e)

    if (done.deny === undefined && done.isError !== true && /\.tf$/i.test(e.file_path)) {
      const dir = resolve(normal(await $.session.cwd()), folderOf(e.file_path))
      needsFmt.add(dir)
      needsValidate.add(dir)
    }

    return done
  })

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    // Where the command starts: a cd in it can move the session by the time it ends.
    const cwd = normal(await $.session.cwd())
    const done = await next(e)

    if (done.deny === undefined && done.isError !== true && (needsFmt.size > 0 || needsValidate.size > 0)) {
      const runs = covered(e.command, cwd)
      clear(needsFmt, runs.fmt)
      clear(needsValidate, runs.validate)
    }

    return done
  })

  on('turn.complete', async ($, e, next) => {
    const verbs = [needsFmt.size > 0 && 'fmt', needsValidate.size > 0 && 'validate'].filter(Boolean).join(' and ')
    const cwd = normal(await $.session.cwd())
    // The folders named relative to the session's, which itself goes unnamed.
    const dirs = [...new Set([...needsFmt, ...needsValidate])]
      .filter(dir => dir !== cwd)
      .map(dir => (isInside(dir, cwd) ? dir.slice(cwd.length + 1) : dir))
    const where = dirs.length === 0 ? '' : ` (in ${dirs.slice(0, 3).join(', ')}${dirs.length > 3 ? `, +${dirs.length - 3} more` : ''})`

    $.ui.status(verbs === '' ? undefined : `terraform ${verbs} not run since the last .tf edit${where}`)

    return next(e)
  })
}
