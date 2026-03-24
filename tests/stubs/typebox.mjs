export const Type = new Proxy(
	{},
	{
		get(_target, property) {
			return (...args) => ({
				kind: String(property),
				args,
			});
		},
	},
);
