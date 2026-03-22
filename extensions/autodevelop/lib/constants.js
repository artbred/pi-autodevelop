export const LOOP_STATE_VERSION = 1;

export const BACKLOG_KINDS = ["research", "code", "test", "verify"];
export const ITEM_STATUSES = ["pending", "in_progress", "done", "blocked"];
export const LOOP_PHASES = [
	"planning",
	"researching",
	"implementing",
	"testing",
	"verifying",
	"paused",
	"blocked",
	"complete",
	"stopped",
];

export const ACTIVE_PHASES = new Set(["planning", "researching", "implementing", "testing", "verifying"]);
export const READ_ONLY_PHASES = new Set(["planning", "researching", "verifying"]);
export const EXECUTION_PHASES = new Set(["implementing", "testing"]);
export const PAUSED_OR_TERMINAL_PHASES = new Set(["paused", "blocked", "complete", "stopped"]);

export const GOAL_SECTION_ORDER = ["Goal", "Success Criteria", "Constraints", "Out of Scope", "Notes"];

export const LOOP_SKILL_COMMAND = "/skill:auto-develop-loop";

export const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "grep", "find", "ls", "edit", "write"]);
