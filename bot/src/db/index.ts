type SQL = InstanceType<typeof Bun.SQL>;

export const createDb = (url: string): SQL => new Bun.SQL(url);

export const detectDialect = (url: string): "sqlite" | "postgres" => {
	if (url.startsWith("sqlite:")) {
		return "sqlite";
	}
	if (url.startsWith("postgres:") || url.startsWith("postgresql:")) {
		return "postgres";
	}
	throw new Error(`Unsupported database URL scheme: ${url}`);
};
