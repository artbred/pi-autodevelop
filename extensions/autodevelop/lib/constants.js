export const LOOP_STATE_VERSION = 2;

export const BACKLOG_KINDS = ["research", "code", "test", "verify"];
export const ITEM_STATUSES = ["pending", "in_progress", "done", "blocked"];

export const LOOP_MODES = ["delivery", "hardening", "improvement"];
export const LOOP_PHASES = ["planning", "researching", "implementing", "testing", "verifying", "paused", "blocked", "stopped"];
export const LEGACY_LOOP_PHASES = new Set(["improving", "complete"]);

export const ACTIVE_PHASES = new Set(["planning", "researching", "implementing", "testing", "verifying"]);
export const READ_ONLY_PHASES = new Set(["planning", "researching", "verifying"]);
export const EXECUTION_PHASES = new Set(["implementing", "testing"]);
export const PAUSED_OR_TERMINAL_PHASES = new Set(["paused", "blocked", "stopped"]);

export const QUALITY_OBJECTIVE_NAMES = ["performance", "latency", "throughput", "memory", "scalability", "reliability"];
export const QUALITY_OBJECTIVE_STATUSES = ["pending", "in_progress", "addressed", "not_applicable", "opted_out", "blocked"];
export const RESOLVED_QUALITY_OBJECTIVE_STATUSES = new Set(["addressed", "not_applicable", "opted_out"]);
export const QUALITY_HARDENING_PRIORITY = ["reliability", "scalability", "throughput", "latency", "memory", "performance"];
export const IMPROVEMENT_DIRECTIONS = ["observability", "automation", "maintainability", "polish"];

export const GOAL_SECTION_ORDER = [
	"Goal",
	"Success Criteria",
	"Constraints",
	"Out of Scope",
	"Notes",
	"Explicit Opt-Outs",
];

export const LOOP_SKILL_COMMAND = "/skill:auto-develop-loop";

export const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "grep", "find", "ls", "edit", "write"]);
