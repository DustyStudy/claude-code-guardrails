export type Left = string[]

declare module 'claude-code' {
  interface PluginState {
    'cleanup-check': { left: Left }
  }
}
