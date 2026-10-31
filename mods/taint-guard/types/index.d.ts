declare module 'claude-code' {
  interface PluginState {
    'taint-guard': { source: string; resume: boolean }
  }
}

export {}
