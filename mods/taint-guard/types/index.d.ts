/** What untrusted content tainted the session, such as a URL or a tool name. */
export type Source = string

declare module 'claude-code' {
  interface PluginState {
    'taint-guard': { source: Source; resume: boolean }
  }
}
