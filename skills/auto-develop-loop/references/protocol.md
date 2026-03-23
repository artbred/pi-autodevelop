# Auto-Develop Protocol

## Workflow

1. Start by reading the current loop state with `autodevelop_state action="get"`.
2. Read the loop `mode`, `qualityObjectives`, and any goal-file opt-outs before planning.
3. If there is no backlog, create a concrete backlog with `replace_plan`.
4. Pick a single active item and set the phase that matches its kind.
5. Do the work, then update the item status and notes.
6. Update the relevant quality objective with `update_objective` and concrete evidence when you improve or assess it.
7. Run tests or verification before marking implementation work done.
8. Write a concise verification summary before moving on.
9. When the primary goal is satisfied, call `complete` to switch from `delivery` into `hardening`.
10. In `hardening`, resolve enabled quality objectives before drifting into general improvement work.
11. In `improvement`, keep producing new backlog items that make the system better instead of waiting for a new user task.
12. End with `block` only when the next step is unclear, unsafe, impossible, or requires unavailable information.

## Backlog Rules

- Allowed kinds: `research`, `code`, `test`, `verify`
- Allowed statuses: `pending`, `in_progress`, `done`, `blocked`
- Use `objectiveRefs` to link backlog items to `performance`, `latency`, `throughput`, `memory`, `scalability`, or `reliability`.
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

### `block`

Use this when:

- the goal conflicts with repo reality
- required tools, dependencies, or credentials are missing
- tests fail for reasons that require human input
- the immutable goal file changed unexpectedly

Provide a direct reason with the concrete blocker.

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

- Prefer local source code, configs, tests, and docs.
- Use existing session tools for web research only when local evidence is insufficient.
- Do not invent unavailable search tools.

## Hard Rules

- The goal markdown file is immutable.
- The `# Explicit Opt-Outs` section is the only place that disables a default quality objective.
- Do not write loop state into the goal file.
- Do not silently skip verification for code changes.
- Do not treat primary-goal completion as a signal to stop working.
- Do not assume small datasets, low traffic, or ideal conditions unless the goal explicitly constrains the workload that way.
