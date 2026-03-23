---
name: auto-develop-loop
description: Run an autonomous develop-test-verify loop around an immutable markdown goal file managed by the autodevelop extension. Use when the session is actively auto-planning, researching, implementing, testing, hardening, and iterating toward a fixed goal without editing the goal file.
---

# Auto-Develop Loop

Use this skill only when the `autodevelop_state` tool is available and the session is running an auto-develop loop.

1. Call `autodevelop_state` with `action="get"` before changing the plan, marking work complete, or declaring a block.
2. Unless the goal file explicitly opts out, treat `performance`, `latency`, `throughput`, `memory`, `scalability`, and `reliability` as default success dimensions.
3. If the backlog is empty, decompose the goal into small backlog items and call `replace_plan`. Use only `research`, `code`, `test`, and `verify`.
4. Tag items with `objectiveRefs` when they advance one or more quality objectives.
5. Keep one item in progress at a time. Use `set_phase` to match the current work mode before acting.
6. Use `update_objective` to record evidence whenever you address reliability, scalability, throughput, latency, memory efficiency, or performance.
7. Prefer repo-local inspection, existing code, and relevant tests first. Use external web tools only if they already exist in the current session.
8. Before closing an implementation cycle, run verification and record a concise verification summary with `set_phase`.
9. In delivery mode, feature work should already account for scale and reliability rather than assuming small inputs or ideal conditions.
10. If the primary goal is satisfied, call `complete` once to enter hardening mode. Do not treat that as the end of the loop.
11. In hardening mode, prioritize `reliability`, then `scalability`, `throughput`, `latency`, `memory`, and `performance`.
12. In improvement mode, continue with justified enhancements such as observability, automation, maintainability, and polish, while still respecting unresolved hardening objectives.
13. For large-data and high-load systems, inspect chunking, batching, streaming, pagination, memory pressure, queue depth, retries, timeouts, idempotency, and backpressure unless explicitly opted out.
14. Never modify the goal markdown file. Never rewrite or reinterpret the goal as mutable working notes.

See [the protocol reference](references/protocol.md) for the loop contract and action details.
