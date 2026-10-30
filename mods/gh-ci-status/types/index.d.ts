export type Pr = {
  url: string
  repo: string
  number: number
  // The commit the checks ran on: the merge is pinned to it.
  sha: string
  isDraft: boolean
  checks: 'pending' | 'passed' | 'failed' | 'none'
  failing: string
  // The failing check's page: an Actions job's holds the id its log is read by.
  failingUrl: string
  // The base moved on and branch protection wants the branch up to date before it merges.
  behind: boolean
  // It conflicts with its base: someone has to resolve that before it can rebase or merge.
  conflicts: boolean
  // What reviewers decided: '' when no review is required or it is approved.
  review: '' | 'needs approval' | 'changes requested'
  // A job held for an environment's required reviewers, by name; '' when none.
  waiting: string
  // A branch rule holds the merge (a review, a required check, an unresolved conversation).
  blocked: boolean
  branch: string
  // Workflow runs on the head commit held for approval (a pull request a workflow opened), by id.
  runs: number[]
}

declare module 'claude-code' {
  // The mod's own tool, typed here so a type check does not wait on a connected session.
  interface McpToolInputs {
    'mcp__gh-ci-status__checks': { url?: string }
  }

  interface PluginState {
    'gh-ci-status': { prs: Pr[]; armed: string; merging: string; rebasing: string; merged: string[] }
  }
}
