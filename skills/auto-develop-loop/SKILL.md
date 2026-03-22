---
name: auto-develop-loop
description: Run an autonomous develop-test-verify loop around an immutable markdown goal file managed by the autodevelop extension. Use when the session is actively auto-planning, researching, implementing, testing, and iterating toward a fixed goal without editing the goal file.
---

# Auto-Develop Loop

Use this skill only when the `autodevelop_state` tool is available and the session is running an auto-develop loop.

1. Call `autodevelop_state` with `action="get"` before changing the plan, marking work complete, or declaring a block.
2. If the backlog is empty, decompose the goal into small backlog items and call `replace_plan`. Use only `research`, `code`, `test`, and `verify`.
3. Keep one item in progress at a time. Use `set_phase` to match the current work mode before acting.
4. Prefer repo-local inspection, existing code, and relevant tests first. Use external web tools only if they already exist in the current session.
5. After each meaningful step, update the active backlog item with `update_item`.
6. Before closing an implementation cycle, run verification and record a concise verification summary with `set_phase`.
7. If the goal is satisfied, call `complete`. If the loop cannot proceed safely or correctly, call `block`.
8. Never modify the goal markdown file. Never rewrite or reinterpret the goal as mutable working notes.

See [the protocol reference](references/protocol.md) for the loop contract and action details.
