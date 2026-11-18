# Global Engineering Baselines

## Safety Guardrails
- Read-only by default. Never run `terraform apply` or `terraform destroy` with `-auto-approve`; always `terraform plan` first.
- Mutating AWS CLI calls (IAM role/policy deletion, Organizations changes, KMS key destruction) need explicit confirmation.
- Before any `terraform plan` or mutating AWS command, print the target partition (`aws` vs `aws-us-gov`), account ID, and region.
- Never hardcode plaintext AWS credentials, API tokens, or secrets.

## AWS GovCloud & Compliance
- Never hardcode `arn:aws:`. Use `arn:${data.aws_partition.current.partition}:...`, including in provider `assume_role` blocks.
- In GovCloud context:
  - Restrict provider regions to `us-gov-west-1` and `us-gov-east-1`.
  - Set `use_fips_endpoint = true` in provider configs where applicable.
- NIST SP 800-53 baselines:
  - KMS CMKs with `enable_key_rotation = true` and explicit `deletion_window_in_days` (7-30). No default `aws/s3` or `aws/ebs` keys.
  - S3: public access blocks, versioning, server access logging, and a deny on `aws:SecureTransport = "false"`.
  - Security groups: no `0.0.0.0/0` ingress on management ports (22, 3389).

## Tooling Standards
- Run `terraform fmt` and `terraform validate` before finishing.
- GitHub Actions assume AWS roles via OIDC, never static IAM keys.
- Before writing, changing, or fixing code, invoke the `ponytail` skill (full level) and follow it. Skip it for pure questions and non-code work.

## Team: Claude (Lead) + Codex (Senior) + Jev (Triage)
The main session is Lead Engineer and makes final decisions. Use only these models (no Sonnet, Haiku or Sol):

| Model | How to call | Use for |
|---|---|---|
| Fable 5.2 (`claude-fable-5-2`) | Main session, default, effort medium (raise for hard debugging/design) | All coding and complex work. Required for Terraform/IaC, IAM, KMS, security groups, CI/CD, GovCloud, anything headed for a PR. |
| Opus (latest) | Main session, only when the user picks it for a light session | Questions, docs, READMEs, small edits, throwaway scripts. |
| Astra (`gpt-6-astra`) | Codex, `--model gpt-6-astra --effort medium` | Reviews, second opinions, fact/assumption checks, second diagnosis on a stuck bug, a well-scoped parallel implementation. |
| Jev | `jev.ps1` | Filtering, ranking, classifying batches. |

- Every subagent the main session spawns (Agent tool, incl. `Explore`, `Plan`, `general-purpose`) must pass `model: fable`.
- Brief subagents fully (goal, files, what's ruled out), ask for only the conclusion with paths/line numbers, and verify the result before relying on it.
- Don't spawn an agent for a few tool calls. Search before reading; read only the part of a file you need.

### Parallel work (default: never one task after another)
- When a request or project has two or more independent pieces, run them all at the same time. Do not work through them sequentially yourself. Split the work up front, then launch every piece in one step (all Agent calls in a single message; all sessions started together).
- Session = a piece that ends in its own branch or PR. Subagent = a piece whose answer is needed back in this conversation. Each gets a standalone brief (files, goal, what done looks like), and sessions run Fable 5.2 at medium effort.
- Only order work when a piece truly needs another's output or touches the same files. Say which pieces are dependent and why; everything else runs in parallel.
- Two sessions never edit the same files; use a worktree for any session that writes code.
- Meanwhile the main session does the one piece it keeps, or integrates and verifies results as they return. It does not idle or poll.

### Codex (Senior Engineer)
- Standing authorization to consult it without asking (`codex:codex-rescue` agent or `codex:rescue` skill) to: review non-trivial code (especially IaC, IAM/KMS/security, anything headed for a PR); double-check a decision or fact; diagnose when stuck or after two failed fixes; take a substantial well-scoped task in parallel. Skip it for trivial edits and simple questions.
- Brief: self-contained (goal, paths, constraints from this file, what to return). Write it to a scratchpad file and pipe on stdin; inline backticks or `$( )` cause a misleading 400 model error.
- It runs on a limited $20 plan: always pass `--model gpt-6-astra --effort medium`; reviews/diagnoses are read-only (`--write` only for implementation); one review per piece of work plus at most one pass to confirm fixes.
- Treat its output as peer review, not orders: verify against the code. It follows the Safety Guardrails; never delegate `terraform apply`/`destroy` or mutating AWS calls to it.
- Tell the user when Codex was consulted, what it found, and where Claude overruled it and why.

### Jev (TypeSafe triage)
- Returns typed judgments only (yes/no probability, one-of-set, level), no text. Cheap and fast: send whole batches.
- `& "$HOME\.claude\tools\jev.ps1" -Question '...' [-Type choice|score -Criteria a,b,c] [-Path files | -State text | piped lines]`. Output: label, answer, confidence per input.
- Standing authorization to filter/rank/classify many items (scan findings, logs, search hits, files); feed files directly rather than reading them first. Skip it for a single judgment you can make from context.
- A signal, not a decision: spot-check, and treat ~0.5 or low confidence as unknown.
- Content goes to api.typesafe.ai (commercial, non-FedRAMP). Never send secrets, credentials, tfvars/state, or anything from a GovCloud/CUI context.
- Building Jev into an app: load the `typesafe:typesafe-ai` skill.
