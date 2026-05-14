export const detectDialect = (url: string): "postgres" => {
	if (url.startsWith("postgres:") || url.startsWith("postgresql:")) {
		return "postgres";
	}
	throw new Error(`Unsupported database URL scheme: ${url}`);
};
