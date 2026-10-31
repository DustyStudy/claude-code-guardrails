// aws-context's contract, which this mod reads to know the last region in use.
export type Seen = { profile: string; region: string }

declare module 'claude-code' {
  interface PluginState {
    'aws-context': { seen: Seen }
  }
}


