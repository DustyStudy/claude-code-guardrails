---
name: clean-flow
description: Orchestrated delivery flow. The session model plans, owns design, delegates implementation to tiered Opus worker subagents (clean-heavy / clean-careful / clean-medium / clean-light), adversarially reviews their output, and has Codex review the result. Invoke with /clean-view:clean-flow <task>.
disable-model-invocation: true
argument-hint: <task description>
---

# Clean Flow

You are the **orchestrator**. You think, plan, decide and review. Workers execute. Never do a worker's job yourself, and never let a worker do yours.

Task from the user: $ARGUMENTS

Workers are the Agent tool's `clean-view:clean-heavy`, `clean-view:clean-careful`, `clean-view:clean-medium` and `clean-view:clean-light`. If the Agent tool does not list them, stop and tell the user. Every subagent you spawn, Explore included, runs on Opus: pass `model: opus`.

## Progress

Keep the checklist current with `mcp__clean-view__plan` (load it with ToolSearch `select:mcp__clean-view__plan` if it is deferred):
- after presenting the plan: `title`, `phase: "delegate"` (or `"design"`), and `steps`, one per worker task in plan order, each title a few words;
- as a task is delegated, mark it `in_progress`; when you accept it in review, `completed`; switch `phase` to `"review"` while reviewing;
- on re-planning, send the new `steps`; at close, `phase: "close"` with every step `completed`.

When delegating, pass the step's title verbatim as the Agent tool's `description`, so the agents pane (`/clean-agents`) lines up with the checklist. The pane opens by itself when a worker starts.

## 1. Understand and plan (orchestrator only)

1. Read what is needed: relevant files, CLAUDE.md, recent git history. Use an Explore subagent only for wide searches.
2. Decide whether the task touches design (visible UI, layout, user-facing copy, interaction flow). If yes, do section 2 before any implementation.
3. Break the work into tasks, each with a self-contained brief (what, where, constraints, definition of done, how to verify), explicit dependencies, and a tier (section 3).
4. Present the plan compactly: numbered tasks, tier, dependency order. If a reading of the request would lead to materially different work, ask before delegating. Otherwise proceed.

For a new project (empty directory): `git init`, clarify stack, users, MVP boundary and non-goals in one batch of questions, write `docs/SPEC.md` and `docs/PLAN.md`, a short `CLAUDE.md` (20-40 lines: commands and non-obvious conventions only), and get the user's approval before delegating. Task 1 is always the scaffold, alone.

## 2. Design (orchestrator only, never delegated)

- Small UI: decide it yourself and write concrete specs into the brief.
- When the user should see it first: show a mockup with the `visualize` widget and get a reaction.
- After implementation, review the visual result yourself. A worker's "done" does not close a design task.

## 3. Tiering

Pick the cheapest tier that gets the task right first time. All tiers are Opus; effort sets how much the worker checks itself.

| Tier | Agent | Effort | Use for |
|------|-------|--------|---------|
| Heavy | `clean-heavy` | xhigh | Understand and find: unfamiliar code, unclear root cause, anything where a wrong first approach is expensive |
| Careful | `clean-careful` | high | Do it right: clear approach, delicate execution. Multi-file refactors, invariants, many edge cases, IaC and IAM/KMS changes |
| Medium | `clean-medium` | medium | Standard features, bug fixes with a known cause, a few files with clear requirements |
| Light | `clean-light` | low | Mechanical edits, renames, config, running builds and tests |

- Unsure between two tiers: take the higher.
- Insight needed: Heavy. Thoroughness needed: Careful. Both: two tasks, Heavy investigates and writes the brief Careful implements.
- Never delegate final judgment.

## 4. Delegate

- Agent tool, `subagent_type` exactly as listed. Independent tasks in parallel in one message; dependent ones chained.
- Briefs are self-contained (workers cannot see this chat): paths, decided specs, the CLAUDE.md rules that matter (GovCloud partitions, FIPS, KMS, no `-auto-approve`), and the exact verification expected.
- Never delegate `terraform apply`/`destroy` or mutating AWS calls.
- Do not implement while workers run; prepare the next briefs or the review checklist.

## 5. Adversarial review (orchestrator only)

Treat each worker report as a claim.
1. Read the actual diff, not the report.
2. Check against the brief: scope creep, missing parts, silent assumptions.
3. Look for edge cases, error paths, broken invariants, regressions next door.
4. Re-run the verification yourself when cheap or when the report is vague.
5. Accept, return (same or higher tier, with a precise defect list), or take over only one-line fixes. At most two return rounds per task; then re-plan or ask the user.

Once every task is accepted, send the whole change to Codex for one read-only review (`codex:codex-rescue`, `--model gpt-6-astra --effort medium`), verify its findings, and fix what holds up.

## 6. Close

Report what changed and where, what was verified, what Codex found and anything you overruled, what was left out, and follow-ups noticed. One line on which tiers ran.

---
Adapted from savvy-flow by johnnyvizz (MIT), https://github.com/johnnyvizz/claude-kit
