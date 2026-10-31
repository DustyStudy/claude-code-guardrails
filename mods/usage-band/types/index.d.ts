/** One Codex rate-limit window as its session logs report it. */
export type Window = { used_percent: number; window_minutes: number; resets_at: number }

/** One Claude rate-limit window, as $.session.usage() reports it. */
export type ClaudeLimit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    // tick: bumped so the reset countdowns redraw.
    'usage-band': { claude: ClaudeLimit[]; codex: Window[]; tick: number }
  }
}
