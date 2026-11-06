import type { Register } from 'claude-code'

import { HEREDOC, invocations } from './shell'

const bin = (names: string) => new RegExp(String.raw`^(.*[\\/])?(${names})(\.exe|\.cmd|\.ps1)?$`, 'i')

// One spelling per path: forward slashes, lower case, Git Bash's /c/ as c:/, . and .. resolved. Windows also opens a path through
// \\?\ or \\.\, drops a name's trailing dots and spaces, and reads name:stream as the file itself, so those spell the same path.
const norm = (path: string) => {
  const parts: string[] = []
  const plain = path.replace(/\\/g, '/').replace(/^\/\/[?.]\//, '').replace(/^\/([a-z])(\/|$)/i, '$1:/').toLowerCase()

  for (const [i, raw] of plain.split('/').entries()) {
    const part = raw === '.' || raw === '..' ? raw : i === 0 ? raw : raw.replace(/:.*$/, '').replace(/[. ]+$/, '')

    if (part === '..') {
      if (parts.length > 1) {
        parts.pop()
      }
    } else if (part !== '.' && (part !== '' || parts.length === 0)) {
      parts.push(part)
    }
  }

  return parts.join('/') || '/'
}

const isAbsolute = (path: string) => /^([\\/]|[a-z]:([\\/]|$))/i.test(path)
const isAt = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)

const HOME_VAR = /^(~|\$HOME|\$\{HOME\}|\$env:(USERPROFILE|HOME)|\$\{env:(USERPROFILE|HOME)\}|%USERPROFILE%)(?=[\\/]|$)/i

// What Claude Code loads as its own config or code: what a change there does to every later session.
type Guarded = { roots: readonly string[]; open: readonly string[] }

// ~/.claude and ~/.claude.json, and every mod folder, except what the session writes itself: memory, transcripts, plans.
const guardedOf = (home: string, pluginDirs: string): Guarded => {
  const at = norm(home)
  // CLAUDE_CODE_PLUGIN_DIRS is ;-separated on Windows, :-separated elsewhere.
  const separator = pluginDirs.includes(';') || /^[a-z]:/i.test(pluginDirs) ? ';' : ':'

  return {
    roots: [`${at}/.claude`, `${at}/.claude.json`, ...pluginDirs.split(separator).filter(Boolean).map(norm)],
    open: [`${at}/.claude/projects`, `${at}/.claude/plans`],
  }
}

// A project's own settings can add hooks and permissions too.
const PROJECT_SETTINGS = /(^|\/)\.claude\/settings(\.local)?\.json$/

const isGuarded = (path: string, guarded: Guarded) =>
  PROJECT_SETTINGS.test(path) || (guarded.roots.some(root => isAt(path, root)) && !guarded.open.some(root => isAt(path, root)))

const resolve = (path: string, cwd: string, home: string) => {
  const expanded = path.replace(HOME_VAR, home)

  return norm(isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`)
}

// A command line's words, quoted runs kept whole (a path can hold spaces), as paths: -Path:x and of=x name x, and a,b is two.
const paths = (command: string, cwd: string, home: string) =>
  (command.match(/(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&()<>`])+/g) ?? [])
    .flatMap(word => word.replace(/["']/g, '').split(','))
    .map(word => word.replace(/^-\w+:(?![\\/])/, '').replace(/^\w+=/, '').replace(/^\{+/, ''))
    // A brace left at the end closes a block or group; ${HOME} was read before it goes.
    .map(word => word.replace(HOME_VAR, home).replace(/\}+$/, ''))
    .filter(Boolean)
    .map(word => resolve(word, cwd, home))

// shortcut: a path is found only as written (whole, or with ~ and the home variables); one built from pieces (Join-Path $HOME ".cl"),
// a variable set elsewhere, or an 8.3 short name slips past. No parser fixes that: for it, make the dirs read-only to Claude's account.
const mentions = (command: string, cwd: string, home: string, guarded: Guarded, preloads: boolean) =>
  isGuarded(norm(cwd), guarded) ||
  paths(withoutDataHeredocs(command, cwd, home, guarded, preloads), cwd, home).some(path => isGuarded(path, guarded))

// A shell or wrapper with no arguments is no call to invocations, but it runs the text it reads: cat <<EOF | sh.
const RUNNER =
  /(^|[\s;|&(\\/"'])(bash|sh|zsh|dash|ksh|pwsh|powershell|cmd|wsl|xargs|env|eval|exec|source|\.|sudo|time|timeout|nohup|winpty|iex|invoke-expression)(\.exe)?(?=[\s;|&)"']|$)/i
// A heredoc body fed only to programs that read it as data (a commit message, a Codex brief) names no path for them to change, so
// it is not searched. It is when it can run or be kept to run later: a shell or wrapper on the opening line (s'h' is sh), a pipe or
// && left open to a later line, a redirection that saves it, or an unquoted tag whose body holds $( ) or `. The opening line always is.
const withoutDataHeredocs = (command: string, cwd: string, home: string, guarded: Guarded, preloads: boolean) =>
  command.replace(HEREDOC, (match: string, quote: string, _tag: string, rest: string, at: number, source: string) => {
    const first = rest.split('\n')[0] ?? ''
    // A comment ends the line for the shell, so a pipe before it is still open: cat <<EOF | # note.
    const opening = `${source.slice(source.lastIndexOf('\n', at) + 1, at)} ${first}`.replace(/(^|\s)#.*$/, '')
    const calls = invocations(opening, /./).length
    const canRun =
      RUNNER.test(opening.replace(/["']/g, '')) || /[|&\\]\s*$/.test(opening) || writesFile(opening) || (!quote && /\$\(|`/.test(rest))

    return !canRun &&
      calls > 0 &&
      calls ===
        invocations(opening, READER).length +
          invocations(opening, GIT).filter(isGitMessage).length +
          (preloads ? 0 : invocations(opening, NODE).filter(args => isCodexRun(args, cwd, home, guarded)).length)
      ? `<< ${first}`
      : match
  })

// Deleting or moving a folder above a guarded one takes it along: rm -rf .claude, Remove-Item -Recurse ~/.claude/..
const REMOVER = bin('rm|Remove-Item|ri|del|erase|rd|rmdir|mv|move|Move-Item|mi|ren|Rename-Item|rni')
const removesAbove = (command: string, cwd: string, home: string, guarded: Guarded) =>
  invocations(command, REMOVER).some(args =>
    paths(args.join(' '), cwd, home).some(path => path.endsWith('/.claude') || guarded.roots.some(root => isAt(root, path))),
  )

// Programs that only read or move around; anything else that touches a guarded path is a change.
const READER = bin(
  'cat|cut|which|type|gc|Get-Content|ls|dir|gci|Get-ChildItem|Get-Item|gi|Test-Path|Resolve-Path|head|tail|less|more|grep|egrep|rg|Select-String|sls|wc|stat|diff|jq|echo|Write-Output|cd|pushd|popd|chdir|Set-Location|sl|pwd|Get-Location|Select-Object|Where-Object|Measure-Object|ConvertFrom-Json|Format-List|Out-String|realpath|dirname|basename',
)
const GIT = bin('git')
const GIT_VALUE = /^(-C|-c|--git-dir|--work-tree|--namespace)$/
const GIT_READS = /^(status|log|diff|show|rev-parse|ls-files|blame|describe)$/
// git diff --output and log -o write a file.
const isGitRead = (args: readonly string[]) =>
  GIT_READS.test(args.find((word, i) => !word.startsWith('-') && !GIT_VALUE.test(args[i - 1] ?? '')) ?? '') &&
  !args.some(arg => /^(--output|-o)/.test(arg))
// git commit and tag with -F - read a heredoc as their message; git apply or am would read it as a patch. Only -C may come before the
// subcommand (-c core.editor=sh can run it), and no editor or template (-e, -t) may open it.
const isGitMessage = (args: readonly string[]) => {
  const at = args.findIndex((word, i) => !word.startsWith('-') && args[i - 1] !== '-C')
  const after = args.slice(at)

  return (
    /^(commit|tag)$/.test(args[at] ?? '') &&
    args.slice(0, at).every((word, i, all) => word === '-C' || all[i - 1] === '-C') &&
    after.some((word, i) => /^(-F-|--file=-)$/.test(word) || (/^(-F|--file)$/.test(word) && after[i + 1] === '-')) &&
    // Short flags combine (-ae), so e or t in a cluster counts, but not as -F's own value (-Fe names a file).
    !after.some(word => /^(--edit|--template)/.test(word) || /^-[^-F]*[et]/.test(word))
  )
}

// A redirection into a file writes it; 2>&1, > /dev/null and a > inside quotes do not.
const writesFile = (command: string) =>
  /\d*>>?(?!&)/.test(command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""').replace(/\d*>>?\s*(\/dev\/null|\$null|nul)\b|\d*>&\d/gi, ''))

const NODE = bin('node')
// The Codex companion runs Codex and keeps its jobs outside the guarded dirs; other plugin scripts can install or uninstall.
const CODEX_COMPANION = /^\/\.claude\/plugins\/cache\/openai-codex\/codex\/[^/]+\/scripts\/codex-companion\.mjs$/
// node <companion> runs it without changing it: it must be node's first word (an option before it, such as -e or --import, runs
// other code), no other argument may name a guarded path, and the review gate it can toggle is a hook in every later session.
const isCodexRun = (args: readonly string[], cwd: string, home: string, guarded: Guarded) => {
  const script = resolve(args[0] ?? '', cwd, home)

  return (
    script.startsWith(`${norm(home)}/`) &&
    CODEX_COMPANION.test(script.slice(norm(home).length)) &&
    !args.some(arg => /review-gate/.test(arg)) &&
    !paths(args.slice(1).join(' '), cwd, home).some(path => isGuarded(path, guarded))
  )
}

// NODE_OPTIONS, in the command or the session's environment, can preload other code into the companion.
const isReadOnly = (command: string, cwd: string, home: string, guarded: Guarded, preloads: boolean) =>
  !writesFile(command) &&
  // Every call is a reader: a wrapper (bash -c, xargs, env) counts as a call of its own and is not one.
  invocations(command, /./).length ===
    invocations(command, READER).length +
      invocations(command, GIT).filter(isGitRead).length +
      (preloads ? 0 : invocations(command, NODE).filter(args => isCodexRun(args, cwd, home, guarded)).length)

// The claude CLI changes plugins, MCP servers and config without naming a path.
const CLAUDE = bin('claude')
// The area is found by name, so an option's value before it (claude --model sonnet plugin ...) is not read as one.
const isConfigChange = (args: readonly string[]) => {
  const at = args.findIndex(word => /^(plugins?|mcp|config)$/.test(word))
  const [action, next] = args.slice(at + 1).filter(word => !word.startsWith('-'))
  const verb = action === 'marketplace' ? next : action

  return at >= 0 && !/^(list|get|show|help|test|validate)?$/.test(verb ?? '')
}

const DENY = 'which Claude Code loads as its own config or code in every later session. If the user wants this, give them the exact edit or command to make themselves.'

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'
    const guarded = guardedOf(home, (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '')
    const file = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path

    return isGuarded(resolve(file, await $.session.cwd(), home), guarded)
      ? { deny: `${$.plugin.name}: this changes ${file}, ${DENY}` }
      : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'
    const guarded = guardedOf(home, (await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '')
    const cwd = await $.session.cwd()
    // shortcut: NODE_OPTIONS set in a shell profile the tool sources is not seen; check the profile if that matters.
    const preloads = /NODE_OPTIONS/i.test(e.command) || Boolean((await $.env.get('NODE_OPTIONS'))?.trim())

    if (invocations(e.command, CLAUDE).some(isConfigChange)) {
      return { deny: `${$.plugin.name}: this changes Claude Code's plugins, MCP servers or config, ${DENY}` }
    }

    return (mentions(e.command, cwd, home, guarded, preloads) && !isReadOnly(e.command, cwd, home, guarded, preloads)) ||
      removesAbove(e.command, cwd, home, guarded)
      ? { deny: `${$.plugin.name}: this command changes files under ~/.claude, a mod folder or a project's .claude settings, ${DENY}` }
      : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` }))
}
