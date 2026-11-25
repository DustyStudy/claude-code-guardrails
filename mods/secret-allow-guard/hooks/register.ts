import type { EngineInterface as Engine, Register } from 'claude-code'

// A literal secret in a permission rule: "Yes, and don't ask again" saves the whole command, secret included.
// The same matchers check env and an MCP server's env, headers, command line and url.
// A value starting with $ is a variable reference and passes.
// Every run before a later literal is bounded: an unbounded one let a repo's .mcp.json hang session start.
const SECRET = [
  /\b(?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH)=["']?(?!\$)[^\s"';]/,
  // A value stops at `)` and `:`, which close a rule (`Bash(mysql -p)`, `Bash(mysql -p:*)`).
  /\bsshpass\b[^;&|]{0,400}\s-p\s*["']?(?!\$)[^\s"'):]/,
  /\b(?:mysql|mariadb)\w*\b[^;&|]{0,400}\s-p["']?(?!\$)[^\s"'):]/,
  // login must be a whole word, not part of a container name such as login-proxy.
  /\b(?:docker|podman|nerdctl|helm)\b[^;&|]{0,200}\slogin(?=\s)[^;&|]{0,200}\s-p\s*["']?(?!\$)[^\s"'):]/,
  /\bredis-cli\b[^;&|]{0,400}\s-a\s*["']?(?!\$)[^\s"'):]/,
  // -u user:password; `:*` ends a rule (`Bash(curl -u admin:*)`).
  /\b(?:curl|wget)\b[^;&|]{0,400}\s(?:-u\s*|--user[= ])["']?[^\s"':]+:(?![$*])[^\s"')]/,
  /--password[= ]["']?(?!\$)[^\s"'):-]/i,
  // --token x and --api-key x, the value after a space; --with-token and --token-file name no value.
  /--[\w-]{0,40}(?:token|api[_-]?key|access[_-]?key|secret[_-]?key)\s+["']?(?![$*-])[^\s"'):]{6,}/i,
  /secret_access_key\s+["']?(?!\$)[A-Za-z0-9/+]{40}\b/i,
  /\bbearer\s+(?!\$)[A-Za-z0-9._~+/-]{8,}/i,
  // Any other scheme: Basic, token. A value that is all one `<placeholder>` passes.
  /\bauthorization:\s*\w+\s+(?!\$|<[^<>\s"']{0,80}>(?:[\s"')]|$))[^\s"']{8,}/i,
  /\b(?:[sr]k_live_[A-Za-z0-9]{20,}|AIza[\w-]{35}|eyJ[\w-]{10,1000}\.eyJ[\w-]{10,}\.)/,
  /\bsb_secret_[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,})/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsbp_[a-f0-9]{40}\b/,
  // The next four have tf-lint's shape, so the two mods agree on them.
  /\bxapp-\d-[A-Za-z0-9-]{10,}/,
  /hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{20,}/,
  /AccountKey=[A-Za-z0-9+/]{86}==/,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  // user:password@host in a connection string or URL.
  /[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@"']+:(?!\$)[^\s@"'/]+@/i,
  // No leading \b, so a compound name like SUPABASE_SECRET_KEY= counts; a bare pass needs one (DB_PASS=, not bypass=).
  // Only a whole PWD entry or a name ending _FILE exempts a path; only token_type exempts bearer.
  /(?:pass(?:word|wd|phrase)|(?<![a-z])pass|(?!^pwd\s*[=:]\s*["']?(?:[~.]{0,2}[\\/]|[a-z]:[\\/]))pwd|secret|(?!(?<![a-z0-9_])token_type\s*[=:]\s*["']?bearer(?:[&\s"')]|$))token|api[_-]?key|access[_-]?key)(?!(?:_[a-z]{1,30}){0,5}_file\s*[=:]\s*["']?(?:[~.]{0,2}[\\/]|[a-z]:[\\/]))(?:_[a-z]{1,30}){0,6}\s*[=:]\s*["']?(?!\$)[^\s"',;)]{6,}/i,
]

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

// `NAME=value` and `Name: value`, so the name-based matchers apply as well as the key formats.
const pairs = (value: unknown, join: string): string[] =>
  Object.entries(record(value)).flatMap(([name, one]) => (typeof one === 'string' ? [`${name}${join}${one}`] : []))

const servers = (value: unknown): string[] =>
  Object.values(record(value)).flatMap(server => {
    const { env, headers, command, args, url } = record(server)
    // command and args as one line, so `--api-key` and the value after it read as they do in a rule.
    const line = [command, ...(Array.isArray(args) ? args : [])].filter(one => typeof one === 'string').join(' ')

    return [...pairs(env, '='), ...pairs(headers, ': '), line, ...(typeof url === 'string' ? [url] : [])]
  })

// Strict JSON, then the same text without trailing commas.
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'))
  }
}

// Permission rules, env, and MCP servers (also per project, in ~/.claude.json). A file that still does not parse is scanned
// whole: as written, with "NAME": "value" turned into NAME=value so the name-based matchers apply to it too, and with
// ["a", "b" turned into a b so a flag in args meets its value.
const entries = (text: string): string[] => {
  try {
    const parsed = record(parse(text.replace(/^﻿/, '')))
    const permissions = record(parsed.permissions)
    const rules = ['allow', 'ask', 'deny'].flatMap(list => {
      const listed = permissions[list]

      return Array.isArray(listed) ? listed.filter((rule): rule is string => typeof rule === 'string') : []
    })

    return [
      ...rules,
      ...pairs(parsed.env, '='),
      ...servers(parsed.mcpServers),
      ...Object.values(record(parsed.projects)).flatMap(project => servers(record(project).mcpServers)),
    ]
  } catch {
    return [`${text}\n${text.replace(/"\s*:\s*"/g, '=')}\n${text.replace(/"\s*,\s*"|\[\s*"/g, ' ')}`]
  }
}

const findSecrets = (text: string): string[] => entries(text).filter(entry => SECRET.some(one => one.test(entry)))

// 16 hex of SHA-256: enough to tell entries apart, and the entry itself is never kept.
async function fingerprint(entry: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entry))

  return [...new Uint8Array(digest).slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

// A file a tool call may write a permission rule, env or MCP server into.
const WATCHED = /(?:^|[\\/])(?:settings(?:\.local)?\.json|\.claude\.json|\.mcp\.json)$/i

// `seen` holds, per file, fingerprints of the entries last warned of: a file is reported when any entry is new,
// so a secret is told once and a replaced one (same count) is told too.
async function scan($: Engine, files: readonly string[], seen: Map<string, Set<string>>): Promise<string[]> {
  const warnings: string[] = []

  for (const file of new Set(files)) {
    const text = await $.fs.read(file).then(String, () => undefined)
    const matched = text === undefined ? [] : findSecrets(text)
    const found = new Set(await Promise.all(matched.map(fingerprint)))
    const before = seen.get(file) ?? new Set<string>()
    const count = matched.length

    // Count and path only: the warning itself must not carry the secret.
    if ([...found].some(one => !before.has(one))) {
      warnings.push(
        `${file}: ${count} ${count === 1 ? 'entry looks' : 'entries look'} like a literal secret (permission rules, env, or an MCP server's env, headers, args, url or command): delete them and rotate the secrets`,
      )
    }

    seen.set(file, found)
  }

  return warnings
}

async function warn($: Engine, warnings: readonly string[]): Promise<void> {
  if (warnings.length > 0) {
    await $.ui.toast(`${$.plugin.name}: ${warnings.join('; ')}.`, { timeoutMs: 30_000 })
  }
}

// Mid-session: a warning never blocks, so a failed rescan is dropped.
async function rescan($: Engine, files: readonly string[], seen: Map<string, Set<string>>): Promise<void> {
  try {
    await warn($, await scan($, files, seen))
  } catch {
    // dropped
  }
}

export const register: Register = on => {
  const seen = new Map<string, Set<string>>()
  // Calls the rules left to an ask: "Yes, and don't ask again" may save the command as a rule.
  const asked = new Set<string>()
  let files: string[] = []

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = (await $.env.get('USERPROFILE').catch(() => undefined)) ?? (await $.env.get('HOME').catch(() => undefined))
    // CLAUDE_CONFIG_DIR moves the user's settings out of ~/.claude.
    const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
    files = [
      ...[`${e.cwd}/.claude`, ...(home === undefined ? [] : [`${home}/.claude`]), ...(config ? [config] : [])].flatMap(dir => [
        `${dir}/settings.local.json`,
        `${dir}/settings.json`,
      ]),
      `${e.cwd}/.mcp.json`,
      ...(home === undefined ? [] : [`${home}/.claude.json`]),
      ...(config ? [`${config}/.claude.json`] : []),
    ]
    seen.clear()
    const warnings = await scan($, files, seen)

    // The local file is meant to stay on this machine: flag it when git would commit it.
    if (await $.fs.exists(`${e.cwd}/.claude/settings.local.json`).catch(() => false)) {
      // Git missing, failing or slow reads as no repo, so the secret warnings above still show and startup is not held.
      const git = (...args: string[]) =>
        $.process.run(['git', '-C', e.cwd, ...args], { timeoutMs: 5_000 }).catch(() => ({ exitCode: 128 }))
      const tracked = await git('ls-files', '--error-unmatch', '.claude/settings.local.json')

      if (tracked.exitCode === 0) {
        warnings.push('.claude/settings.local.json is tracked by git: run git rm --cached on it and rotate what it held')
      } else if ((await git('check-ignore', '-q', '.claude/settings.local.json')).exitCode === 1) {
        warnings.push('.claude/settings.local.json is not git-ignored: add it to .gitignore')
      }
    }

    await warn($, warnings)

    return result
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)

    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      asked.add(e.tool_use_id)
    }

    return verdict
  })

  // Rescan after a call that was asked about, which may have saved a rule, or one that wrote a watched file.
  // A warning never blocks: a failed rescan is dropped and the call's result returned.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const path = (e as { file_path?: unknown }).file_path
    const wasAsked = e.tool_use_id !== undefined && asked.delete(e.tool_use_id)

    if (wasAsked || (['Edit', 'Write', 'MultiEdit'].includes(e.tool) && typeof path === 'string' && WATCHED.test(path))) {
      await rescan($, files, seen)
    }

    return result
  })

  // A settings file changed outside a tool call, by hand or by another session.
  on('classic.ConfigChange', async ($, e, next) => {
    const result = await next(e)
    await rescan($, files, seen)

    return result
  })
}
