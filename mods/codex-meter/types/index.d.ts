/** Codex runs counted this session. */
export type Session = number

declare module 'claude-code' {
  interface PluginState {
    'codex-meter': { session: Session }
  }
}
