import type { EngineInterface, Register } from 'claude-code'

// Any mention counts, not only a parsed call: dot-sourcing, pwsh -File and wrappers all name the script, and a false hit only means a check.
const JEV = /\bjev\.ps1\b/i
// Files that hold secrets or state, anywhere in the command: a -Path argument, or what is piped into Jev.
const SECRET_FILE =
  /\.tfvars\b|\.tfstate\b|(^|[\\/\s'"=:,*])\.env(\.[\w-]+)?\b|\.(pem|p12|pfx|key)\b|\bid_(rsa|ed25519|ecdsa)\b|(^|[\\/\s'"=:,])\.aws[\\/](credentials|config)\b|\.(npmrc|netrc|pgpass)\b/i
// Secret values typed straight into -State.
const SECRET_VALUE =
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bxox[abpr]-[\w-]{10,}/
// A GovCloud or CUI context, by region, partition or the name of the folder the work is in.
// CUI as its own label: CUI_project and cui-data count, circuit does not.
const GOV = /us-gov-|aws-us-gov|govcloud|(^|[^a-z])cui([^a-z]|$)/i
const SEEN = { plugin: 'aws-context', key: 'seen' } as const

// shortcut: reads the command line only, so a script that calls Jev itself, or files found at run time (gci -Recurse | jev), pass; upgrade to checking the resolved -Path files if that comes into use.
const refusal = async ($: EngineInterface, command: string): Promise<string | undefined> => {
  if (!JEV.test(command)) {
    return undefined
  }

  if (SECRET_FILE.test(command)) {
    return 'it names a secrets, tfvars or state file'
  }

  if (SECRET_VALUE.test(command)) {
    return 'it carries what looks like a key or token'
  }

  // The last region aws-context saw used, then the session's own settings.
  const seen = await $.state.get(SEEN).then(
    got => got.value?.region ?? '',
    () => '',
  )
  const regions = [seen, await $.env.get('AWS_REGION'), await $.env.get('AWS_DEFAULT_REGION')]

  if (GOV.test(command) || GOV.test(await $.session.cwd()) || regions.some(one => one?.startsWith('us-gov-'))) {
    return 'the work is in a GovCloud or CUI context'
  }

  return undefined
}

export const register: Register = on => {
  // A deny, not an ask: in auto mode an ask is settled by the classifier, not the person.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const why = await refusal($, e.command)

    return why === undefined
      ? next(e)
      : {
          deny: `${$.plugin.name}: Jev sends its input to api.typesafe.ai, a non-FedRAMP service, and ${why}. Do this triage locally instead.`,
        }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${$.plugin.name}: its guard failed.` },
  )
}
