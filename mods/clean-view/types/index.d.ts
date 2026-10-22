export type Step = {
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': { isOn: boolean; steps: Step[]; title: string }
  }
}
