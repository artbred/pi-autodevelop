const UNCERTAINTY_PATTERNS = [
	/\bnot sure\b/i,
	/\bunclear\b/i,
	/\bneed to check\b/i,
	/\bneed to verify\b/i,
	/\bunknown\b/i,
	/\bprobably\b/i,
	/\bassum(?:e|ing|ption)\b/i,
];

export function detectUncertaintyMarker(text) {
	if (!text?.trim()) return null;

	for (const pattern of UNCERTAINTY_PATTERNS) {
		const match = text.match(pattern);
		if (match) {
			return match[0];
		}
	}

	return null;
}

