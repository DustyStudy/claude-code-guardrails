import type { Register } from 'claude-code'

// A literal secret in a permission rule: "Yes, and don't ask again" saves the whole command, secret included.
// A value starting with $ is a variable reference and passes.
const SECRET = [
  /\b(?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH)=["']?(?!\$)[^\s"';]/,
  // A value stops at `)` and `:`, which close a rule (`Bash(mysql -p)`, `Bash(mysql -p:*)`).
  /\bsshpass\b[^;&|]*\s-p\s*["']?(?!\$)[^\s"'):]/,
  /\bmysql(?:dump)?\b[^;&|]*\s-p["']?(?!\$)[^\s"'):]/,
  /--password[= ]["']?(?!\$)[^\s"'):-]/i,
  /\bbearer\s+(?!\$)[A-Za-z0-9._~+/-]{8,}/i,
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
  // No leading \b, so a compound name like SUPABASE_SECRET_KEY= counts.
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(?:_[a-z]+)*\s*[=:]\s*["']?(?!\$)[^\s"'$,;)]{6,}/i,
]

type Settings = { permissions?: Partial<Record<'allow' | 'ask' | 'deny', unknown>> }

// The permission rules, numbered as they stand; a file that does not parse is scanned whole.
const rules = (text: string): string[] => {
  try {
    const { permissions = {} } = JSON.parse(text) as Settings

    return (['allow', 'ask', 'deny'] as const).flatMap(list => {
      const entries = permissions[list]

      return Array.isArray(entries) ? entries.filter((rule): rule is string => typeof rule === 'string') : []
    })
  } catch {
    return [text]
  }
}

const findSecrets = (text: string): number => rules(text).filter(rule => SECRET.some(one => one.test(rule))).length

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = (await $.env.get('USERPROFILE').catch(() => undefined)) ?? (await $.env.get('HOME').catch(() => undefined))
    const files = [
      `${e.cwd}/.claude/settings.local.json`,
      `${e.cwd}/.claude/settings.json`,
      ...(home === undefined ? [] : [`${home}/.claude/settings.local.json`, `${home}/.claude/settings.json`]),
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
        warnings.push(`${file}: ${count} permission rule${count === 1 ? '' : 's'} look${count === 1 ? 's' : ''} like a literal secret: delete them and rotate the secrets`)
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
