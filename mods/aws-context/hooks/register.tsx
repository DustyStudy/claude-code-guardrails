import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Seen } from '../types'

const NONE: Seen = { profile: '', region: '' }
const seen = atom({ plugin: 'aws-context', key: 'seen' } as const, NONE)

// Global, so a command that sets several reads as its last one does.
const PROFILE = /(?:AWS_PROFILE\s*=\s*|--profile[ =])["']?([\w.@-]+)/g
const REGION = /(?:AWS_(?:DEFAULT_)?REGION\s*=\s*|--region[ =])["']?([a-z]{2}(?:-[a-z]+)+-\d)/g
// shortcut: a sensitive account is known by text in its profile name (a name or an account id, from AWS_CONTEXT_HIGHLIGHT), upgrade to `aws sts get-caller-identity` if profile names stop carrying it.
const isHighlighted = (profile: string, list: string | undefined) =>
  (list ?? '')
    .split(',')
    .map(one => one.trim().toLowerCase())
    .some(one => one !== '' && profile.toLowerCase().includes(one))

const partitionOf = (region: string) =>
  region.startsWith('us-gov-') ? 'aws-us-gov' : region.startsWith('cn-') ? 'aws-cn' : 'aws'

export const register: Register = on => {
  // The profile is usually given per command (AWS_PROFILE=x terraform ...), so the band shows the last one used.
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const profile = [...e.command.matchAll(PROFILE)].at(-1)?.[1]
    const region = [...e.command.matchAll(REGION)].at(-1)?.[1]

    if (profile !== undefined || region !== undefined) {
      await update($, seen, was => ({
        profile: profile ?? was.profile,
        // A new profile has its own region: the last one seen says nothing about it.
        region: region ?? (profile !== undefined && profile !== was.profile ? '' : was.region),
      }))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const last = await read($, seen)
    const profile = last.profile || (await $.env.get('AWS_PROFILE')) || ''
    const region =
      last.region ||
      (await $.env.get('AWS_REGION')) ||
      (await $.env.get('AWS_DEFAULT_REGION')) ||
      ''

    if (profile === '' && region === '') {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const isSensitive = region.startsWith('us-gov-') || isHighlighted(profile, await $.env.get('AWS_CONTEXT_HIGHLIGHT'))

    return (
      <Box flexDirection="column">
        <Text
          color={isSensitive ? 'warning' : undefined}
          bold={isSensitive}
          dimColor={!isSensitive}
        >
          {`AWS ${profile || 'default profile'} · ${region || 'no region set'} · ${partitionOf(region)}`}
        </Text>
        {await next(e)}
      </Box>
    )
  })
}
