export async function complete() {
	return { content: [] };
}

export function StringEnum(values) {
	return {
		type: "string",
		enum: values,
	};
}
