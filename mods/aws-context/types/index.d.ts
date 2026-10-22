export type Seen = { profile: string; region: string }

declare module 'claude-code' {
  interface PluginState {
    'aws-context': { seen: Seen }
  }
}
