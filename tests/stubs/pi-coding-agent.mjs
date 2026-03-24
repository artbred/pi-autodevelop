export function convertToLlm(messages) {
	return messages;
}

export function serializeConversation(messages) {
	return JSON.stringify(messages, null, 2);
}
