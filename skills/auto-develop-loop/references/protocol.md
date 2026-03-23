# Auto-Develop Protocol

## Workflow

1. Start by reading the current loop state with `autodevelop_state action="get"`.
2. If there is no backlog, create a concrete backlog with `replace_plan`.
3. Pick a single active item and set the phase that matches its kind.
4. Do the work, then update the item status and notes.
5. Run tests or verification before marking implementation work done.
6. Write a concise verification summary before moving on.
7. When the primary goal is satisfied, call `complete` to switch into continuous improvement mode.
8. In improvement mode, keep producing new backlog items that make the system better instead of waiting for a new user task.
9. End with `block` only when the next step is unclear, unsafe, impossible, or requires unavailable information.

## Backlog Rules

- Allowed kinds: `research`, `code`, `test`, `verify`
- Allowed statuses: `pending`, `in_progress`, `done`, `blocked`
- Keep titles short and actionable.
- Prefer several small items over one large item.
- Use notes for findings, partial results, and blockers.
- Use acceptance criteria when the completion condition is specific and testable.

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
- the loop should switch from goal-fulfillment into continuous improvement mode

Provide a concise summary of what proves the primary goal is satisfied. After that, keep going with new improvement work.

## Improvement Mode

When the primary goal has already been satisfied:

- Do not idle.
- Do not wait for a new task just because the first objective was met.
- Create new backlog items that improve the result in concrete ways.
- Prefer improvements that are testable, defensible, and useful.

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
- Do not write loop state into the goal file.
- Do not silently skip verification for code changes.
- Do not treat primary-goal completion as a signal to stop working.
