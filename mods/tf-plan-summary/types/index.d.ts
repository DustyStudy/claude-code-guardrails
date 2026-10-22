// The input of the mod's own tool, typed here so a type check does not wait on a connected session.
export type PlanSummaryInput = { plan: string; dir?: string }

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__tf-plan-summary__plan_summary': PlanSummaryInput
  }
}
