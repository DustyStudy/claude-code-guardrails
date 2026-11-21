import type { Register } from 'claude-code'

// A literal secret in a permission rule: "Yes, and don't ask again" saves the whole command, secret included.
// The same matchers check env and MCP server env and headers.
// A value starting with $ is a variable reference and passes.
const SECRET = [
  /\b(?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH)=["']?(?!\$)[^\s"';]/,
  // A value stops at `)` and `:`, which close a rule (`Bash(mysql -p)`, `Bash(mysql -p:*)`).
  /\bsshpass\b[^;&|]*\s-p\s*["']?(?!\$)[^\s"'):]/,
  /\b(?:mysql|mariadb)\w*\b[^;&|]*\s-p["']?(?!\$)[^\s"'):]/,
  /\b(?:docker|podman|nerdctl|helm)\b[^;&|]*\blogin\b[^;&|]*\s-p\s*["']?(?!\$)[^\s"'):]/,
  /\bredis-cli\b[^;&|]*\s-a\s*["']?(?!\$)[^\s"'):]/,
  // -u user:password; `:*` ends a rule (`Bash(curl -u admin:*)`).
  /\b(?:curl|wget)\b[^;&|]*\s(?:-u\s*|--user[= ])["']?[^\s"':]+:(?![$*])[^\s"')]/,
  /--password[= ]["']?(?!\$)[^\s"'):-]/i,
  // --token x and --api-key x, the value after a space; --with-token and --token-file name no value.
  /--[\w-]*(?:token|api[_-]?key|access[_-]?key|secret[_-]?key)\s+["']?(?![$*-])[^\s"'):]{6,}/i,
  /secret_access_key\s+["']?(?!\$)[A-Za-z0-9/+]{40}\b/i,
  /\bbearer\s+(?!\$)[A-Za-z0-9._~+/-]{8,}/i,
  // Any other scheme: Basic, token.
  /\bauthorization:\s*\w+\s+(?!\$)[^\s"']{8,}/i,
  /\b(?:[sr]k_live_[A-Za-z0-9]{20,}|AIza[\w-]{35}|eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.)/,
  /\bsb_secret_[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,})/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsbp_[a-f0-9]{40}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // user:password@host in a connection string or URL.
  /[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:(?!\$)[^\s@"'/]+@/i,
  // No leading \b, so a compound name like SUPABASE_SECRET_KEY= counts; a bare pass needs one (DB_PASS=, not bypass=).
  /(?:pass(?:word|wd|phrase)|(?<![a-z])pass|pwd|secret|token|api[_-]?key|access[_-]?key)(?:_[a-z]+)*\s*[=:]\s*["']?(?!\$)[^\s"',;)]{6,}/i,
]

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

// `NAME=value` and `Name: value`, so the name-based matchers apply as well as the key formats.
const pairs = (value: unknown, join: string): string[] =>
  Object.entries(record(value)).flatMap(([name, one]) => (typeof one === 'string' ? [`${name}${join}${one}`] : []))

const servers = (value: unknown): string[] =>
  Object.values(record(value)).flatMap(server => [...pairs(record(server).env, '='), ...pairs(record(server).headers, ': ')])

// Permission rules, env, and MCP server env and headers (also per project, in ~/.claude.json); a file that does not parse is scanned whole.
const entries = (text: string): string[] => {
  try {
    const parsed = record(JSON.parse(text))
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
    return [text]
  }
}

const findSecrets = (text: string): number => entries(text).filter(entry => SECRET.some(one => one.test(entry))).length

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = (await $.env.get('USERPROFILE').catch(() => undefined)) ?? (await $.env.get('HOME').catch(() => undefined))
    // CLAUDE_CONFIG_DIR moves the user's settings out of ~/.claude.
    const config = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
    // files[0] stays the local settings file, which the git check below reads.
    const files = [
      ...[`${e.cwd}/.claude`, ...(home === undefined ? [] : [`${home}/.claude`]), ...(config ? [config] : [])].flatMap(dir => [
        `${dir}/settings.local.json`,
        `${dir}/settings.json`,
      ]),
      `${e.cwd}/.mcp.json`,
      ...(home === undefined ? [] : [`${home}/.claude.json`]),
      ...(config ? [`${config}/.claude.json`] : []),
    ]
    const warnings: string[] = []

    for (const file of new Set(files)) {
      const text = await $.fs.read(file).then(String, () => undefined)

      if (text === undefined) {
        continue
      }

      const count = findSecrets(text)

      // Count and path only: the warning itself must not carry the secret.
      if (count > 0) {
        warnings.push(
          `${file}: ${count} ${count === 1 ? 'entry looks' : 'entries look'} like a literal secret (permission rules, env, MCP env or headers): delete them and rotate the secrets`,
        )
      }
    }

    // The local file is meant to stay on this machine: flag it when git would commit it.
    if (await $.fs.exists(files[0]).catch(() => false)) {
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

    if (warnings.length > 0) {
      await $.ui.toast(`${$.plugin.name}: ${warnings.join('; ')}.`, { timeoutMs: 30_000 })
    }

    return result
  })
}
