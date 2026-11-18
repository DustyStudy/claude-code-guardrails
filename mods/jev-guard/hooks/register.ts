import type { EngineInterface, Register } from 'claude-code'

// Any mention counts, not only a parsed call: dot-sourcing, pwsh -File and wrappers all name the script, and a false hit only means a check.
// PowerShell runs tools\jev without its extension, and the API can be called with no script at all.
const JEV = /\bjev\.ps1\b|(^|[\\/\s"'&(])jev(?=[\s"')]|$)|api\.typesafe\.ai/i
// Files that hold secrets or state, anywhere in the command: a -Path argument, or what is piped into Jev.
const SECRET_FILE =
  /\.tfvars\b|\.tfstate\b|\.env(\.[\w-]+|rc)?\b|\.(pem|p12|pfx|key|ppk|jks|keystore)\b|\bid_(rsa|dsa|ed25519|ecdsa)\b|\.(aws|ssh|kube|docker|azure)[\\/]|\bgcloud[\\/]|\.(npmrc|netrc|pypirc|pgpass|git-credentials)\b/i
// Secret values typed straight into -State: the key formats tf-lint denies in an edit.
const SECRET_VALUE =
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY|\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{60,}|glpat-[\w-]{20,}|npm_[A-Za-z0-9]{36}|xox[abprs]-[\w-]{10,}|sk-(ant|proj|svcacct|admin)-[\w-]{20,}|sk-[A-Za-z0-9]{32,}|[sr]k_live_[A-Za-z0-9]{20,}|AIza[\w-]{35}|sbp_[a-f0-9]{40}|sb_secret_[\w-]{20,})/
// A secret passed by its variable ($env:AWS_SECRET_ACCESS_KEY, $GITHUB_TOKEN, env:GITHUB_TOKEN, GetEnvironmentVariable('X_TOKEN'),
// printenv X_TOKEN); Jev's own key is read by the script, not sent as input.
const SECRET_VAR =
  /(\$\{?(script:|global:)?|\benv:\{?|GetEnvironmentVariable\(\s*["']?|\bprintenv\s+)(?!TYPESAFE_API_KEY\b)\w*(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|API_KEY|CREDENTIAL)\w*/i
// Commands whose output is a secret: the whole environment piped on, or a stored credential, secret or Terraform state printed.
const SECRET_OUTPUT =
  /\b(printenv|env|set)\s*\||\benv:\\?\s*[|)]|\bgh\s+auth\s+token|\baws\s+(configure\s+(get|export-credentials)|secretsmanager\s+get-secret-value|ssm\s+get-parameter)|\b(terraform|tofu|terragrunt)\s+(output|show|state\s+pull)|\bgit\s+credential\s+fill/i
// A GovCloud or CUI context, by region, partition or the name of the folder the work is in.
// CUI as its own label: CUI_project and cui-data count, circuit does not.
const GOV = /us-gov-|aws-us-gov|govcloud|(^|[^a-z])cui([^a-z]|$)/i
const SEEN = { plugin: 'aws-context', key: 'seen' } as const

// The `region` of a profile's section in an AWS config file's text, or ''. Same as aws-context's regionIn.
const regionIn = (config: string, profile: string) => {
  const name = `["']?${profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?`
  const header = new RegExp(String.raw`^\[\s*${profile === 'default' ? '(profile\\s+)?' : 'profile\\s+'}${name}\s*\]\s*([#;].*)?$`)
  let isIn = false

  for (const line of config.split(/\r?\n/).map(one => one.trim())) {
    if (line.startsWith('[')) {
      isIn = header.test(line)
    } else if (isIn) {
      const region = /^region\s*=\s*([a-z]{2}(?:-[a-z]+)+-\d)\s*$/.exec(line)?.[1]
      if (region !== undefined) {
        return region
      }
    }
  }

  return ''
}

// shortcut: reads the command line only, so a script that calls Jev itself, or files found at run time (gci -Recurse | jev), pass; upgrade to checking the resolved -Path files if that comes into use.
const refusal = async ($: EngineInterface, command: string): Promise<string | undefined> => {
  // Read it again without quotes and backticks: the shell joins prod.tf''vars and jev.p`s1 back into one name.
  const text = `${command}\n${command.replace(/["'`]/g, '')}`

  if (!JEV.test(text)) {
    return undefined
  }

  if (SECRET_FILE.test(text)) {
    return 'it names a secrets, tfvars or state file'
  }

  if (SECRET_VALUE.test(text) || SECRET_VAR.test(text) || SECRET_OUTPUT.test(text)) {
    return 'it carries what looks like a key or token'
  }

  // The last region aws-context saw used, the session's own settings, then the active profile's region in the config file.
  const seen = await $.state.get(SEEN).then(
    got => got.value,
    () => undefined,
  )
  const profile = seen?.profile || (await $.env.get('AWS_PROFILE')) || 'default'
  const config =
    (await $.env.get('AWS_CONFIG_FILE')) ??
    [(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '', '.aws', 'config'].join('/')
  const regions = [
    seen?.region,
    await $.env.get('AWS_REGION'),
    await $.env.get('AWS_DEFAULT_REGION'),
    regionIn(await $.fs.read(config).then(String, () => ''), profile),
  ]

  if (GOV.test(command) || GOV.test(await $.session.cwd()) || GOV.test(profile) || regions.some(one => one?.startsWith('us-gov-'))) {
    return 'the work is in a GovCloud or CUI context'
  }

  return undefined
}

// Every tool that hands a command line to a shell: Monitor runs it like Bash, the desktop app's terminal tool types it into the user's shell.
const SHELL_TOOLS = ['Bash', 'PowerShell', 'Monitor', 'mcp__terminal__run_in_terminal']
// shortcut: any other MCP tool that runs a command is not read; deny it by name in managed settings (permissions.deny) or add it here.

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: SHELL_TOOLS }, async ($, e, next) => {
    // A Monitor that opens a WebSocket has no command.
    const command = String((e as { command?: unknown }).command ?? '')
    const why = await refusal($, command)

    return why === undefined
      ? next(e)
      : {
          deny: `${$.plugin.name}: Jev sends its input to api.typesafe.ai, a non-FedRAMP service, and ${why}. Do this triage locally instead.`,
        }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
