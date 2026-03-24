# Auto-Develop Protocol

## Workflow

1. Start by reading the current loop state with `autodevelop_state action="get"`.
2. Read the loop `mode`, `qualityObjectives`, and any goal-file opt-outs before planning.
3. If there is no backlog, create a concrete backlog with `replace_plan`.
4. Pick a single active item and set the phase that matches its kind.
5. Use `autodevelop_research` for repo and web research. It is the default research interface and always exists.
6. If implementation, testing, or verification hits uncertainty, assumptions, unknown behavior, unclear failures, or missing evidence, call `autodevelop_state action="flag_uncertainty"` immediately before continuing.
7. Do the work, then update the item notes and intermediate status.
8. When the item satisfies its acceptance criteria, call `request_verification` instead of marking it `done` directly.
9. Update the relevant quality objective with `update_objective` and concrete evidence when you improve or assess it.
10. Run tests or verification-oriented checks before requesting verifier approval.
11. Write a concise verification summary before moving on.
12. When the primary goal is satisfied, call `complete` to switch from `delivery` into `hardening`.
13. In `hardening`, resolve enabled quality objectives before drifting into general improvement work.
14. In `improvement`, keep producing new backlog items that make the system better instead of waiting for a new user task.
15. End with `block` only when the entire loop is unclear, unsafe, impossible, or requires unavailable information. If one backlog item is blocked but other work remains, keep the loop running.

## Backlog Rules

- Allowed kinds: `research`, `code`, `test`, `verify`
- Allowed statuses: `pending`, `in_progress`, `done`, `blocked`
- Use `objectiveRefs` to link backlog items to `performance`, `latency`, `throughput`, `memory`, `scalability`, or `reliability`.
- Use `evidenceRefs` to cite persisted research artifact ids.
- Use `dependsOnResearchItemIds` when later work is blocked on specific research items.
- Set `researchRequired=true` on non-research items that cannot complete until research evidence exists.
- Every item is verifier-gated by default. Do not plan around skipping verification.
- Keep titles short and actionable.
- Prefer several small items over one large item.
- Use notes for findings, partial results, and blockers.
- Use acceptance criteria when the completion condition is specific and testable.

## Default Quality Objectives

Unless the goal file explicitly opts out, all of these are active:

- `reliability`
- `scalability`
- `throughput`
- `latency`
- `memory`
- `performance`

Quality objective statuses:

- `pending`
- `in_progress`
- `addressed`
- `not_applicable`
- `opted_out`
- `blocked`

## Phase Mapping

- `research` -> `researching`
- `code` -> `implementing`
- `test` -> `testing`
- `verify` -> `verifying`

## Tool Actions

### `get`

Read the current loop state before modifying it.

### `replace_plan`

Replace the entire backlog when:

- the loop is just starting
- the backlog is obsolete
- new information requires a cleaner decomposition

Do not call `replace_plan` for tiny edits that can be handled with `update_item`.

### `update_item`

Use this after concrete progress. Typical transitions:

- `pending` -> `in_progress`
- `in_progress` -> `done`
- `in_progress` -> `blocked`

Validation rules:

- `research` items require at least one `evidenceRef` before they can be marked `done`
- `code`, `test`, and `verify` items with `researchRequired=true` require `evidenceRefs` before they can be marked `done`
- any item with unfinished `dependsOnResearchItemIds` cannot be marked `done`
- any verifier-gated item requires a passing verifier result before it can be marked `done`

### `set_phase`

Use this to keep the loop mode aligned with the active work. Also use it to attach:

- `verificationSummary` after checks, tests, or manual review
- `failure` when a phase change is driven by a concrete failure or issue

### `update_objective`

Use this whenever you assess or improve a default quality objective.

- `objective` must be one of the six default quality objectives
- `status` should reflect the current state of that objective
- `evidence` should capture the concrete proof, reasoning, or observation

Examples:

- chunking added for large inputs -> `scalability`, `addressed`
- retries and timeout handling improved -> `reliability`, `addressed`
- no meaningful latency path exists -> `latency`, `not_applicable`

### `flag_uncertainty`

Use this when code, test, or verify work hits:

- missing evidence
- ambiguous behavior
- external dependency unknowns
- scale or reliability doubts
- unclear failures
- assumptions that need proof

Behavior:

- the current non-research item is set back to `pending`
- that item becomes `researchRequired=true`
- a linked `research` item is inserted ahead of it
- the loop switches into `researching`

After the research item is complete, attach its artifact ids through `evidenceRefs` before completing the blocked item.

### `request_verification`

Use this when an item satisfies its acceptance criteria and is ready for an external read-only review.

Validation rules:

- every item must have `acceptanceCriteria`
- `research` items still require `evidenceRefs`
- research-blocked items still require `evidenceRefs`
- direct completion without verifier approval will be rejected

Behavior:

- the item enters verifier review
- the extension persists a verifier request packet and runs the verifier backend
- `pass` marks the item done
- `pass_with_notes` marks the item done and preserves the notes
- `fail` reopens the item and may insert follow-up research when evidence is missing

### `block`

Use this when:

- the goal conflicts with repo reality
- required tools, dependencies, or credentials are missing
- tests fail for reasons that require human input
- the immutable goal file changed unexpectedly

Provide a direct reason with the concrete blocker.

Behavior:

- the targeted item is marked `blocked`
- if other runnable backlog items remain, the loop continues with the next best work
- the loop enters phase `blocked` only when no runnable work remains

### `complete`

Use this when:

- the implementation matches the goal
- relevant verification is complete
- the loop should switch from goal-fulfillment into hardening mode

Provide a concise summary of what proves the primary goal is satisfied. After that, keep going with hardening and improvement work.

## Hardening Mode

When the primary goal has already been satisfied, hardening comes first:

- Do not idle.
- Do not wait for a new task just because the first objective was met.
- Replan immediately when backlog is empty.
- Prioritize `reliability`, then `scalability`, `throughput`, `latency`, `memory`, and `performance`.
- Prefer improvements that are testable, defensible, and useful.

Large-data and high-load review checklist:

- chunking and batching
- streaming and pagination
- memory pressure and bounded working sets
- queue depth and backpressure
- concurrency limits
- retries, timeouts, and idempotency
- partial-failure handling

## Improvement Mode

After hardening objectives are responsibly handled:

- Continue with observability, diagnostics, automation, maintainability, polish, and other justified improvements.
- If a new quality concern is discovered, route work back through the relevant objective and record evidence.

Good improvement directions:

- tighter tests or higher confidence
- refactors that reduce complexity or clarify ownership
- stronger error handling or recovery
- better automation and tooling
- performance or resource improvements
- documentation that removes ambiguity
- observability, diagnostics, and debugging improvements
- user-facing polish that makes the system work better

## Research Guidance

- Prefer local source code, configs, tests, and docs first.
- Use `autodevelop_research action="query"` for repo or web research instead of assuming session search tools exist.
- Use `scope="repo"` for pure local investigation, `scope="auto"` by default, and `scope="web"` only when you explicitly need web-only research.
- Use `autodevelop_research action="fetch"` to persist files, URLs, or prior artifacts as durable evidence.
- If no external provider is available, local research still works; do not block the loop just because web research is unavailable.

## Hard Rules

- The goal markdown file is immutable.
- The `# Explicit Opt-Outs` section is the only place that disables a default quality objective.
- Do not write loop state into the goal file.
- Do not silently skip verification for code changes.
- Do not mark an item done directly when it should go through `request_verification`.
- Do not treat primary-goal completion as a signal to stop working.
- Do not assume small datasets, low traffic, or ideal conditions unless the goal explicitly constrains the workload that way.
- Do not continue code, test, or verify work through uncertainty without routing it through `flag_uncertainty` and a dedicated research item.
