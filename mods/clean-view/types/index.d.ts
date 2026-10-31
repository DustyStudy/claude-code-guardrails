export type Step = {
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

// One subagent run, as the agents pane shows it.
export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      isOn: boolean
      steps: Step[]
      title: string
      phase: Phase | ''
      agents: AgentRun[]
      now: number
    }
  }
}
