export type WhereOperator =
	| "eq"
	| "ne"
	| "lt"
	| "lte"
	| "gt"
	| "gte"
	| "contains"
	| "in"
	| "between"
	| "isnull";

export type AggregationFn =
	| "count"
	| "sum"
	| "mean"
	| "min"
	| "max"
	| "median"
	| "stddev";

export type WhereClause = {
	column: string;
	op: WhereOperator;
	value?: unknown;
};

export type Aggregation = {
	fn: AggregationFn;
	column?: string;
	alias?: string;
};

export type TabularSchema = {
	path: string;
	sheet: string;
	columns: Array<{ name: string; dtype: string }>;
	rowCount: number;
};

export type TabularRows = {
	columns: string[];
	rows: unknown[][];
};

export type TabularGroups = {
	columns: string[];
	rows: Array<Record<string, unknown>>;
};

export interface TabularEngine {
	describe(data: Uint8Array, filename: string, sheet?: string): Promise<TabularSchema>;
	head(data: Uint8Array, filename: string, n: number, sheet?: string): Promise<TabularRows>;
	sample(data: Uint8Array, filename: string, n: number, sheet?: string, seed?: number): Promise<TabularRows>;
	distinct(
		data: Uint8Array,
		filename: string,
		column: string,
		limit: number,
		sheet?: string,
	): Promise<{ column: string; values: unknown[] }>;
	filter(
		data: Uint8Array,
		filename: string,
		where: WhereClause[],
		select: string[] | undefined,
		limit: number,
		sheet?: string,
	): Promise<TabularRows>;
	aggregate(
		data: Uint8Array,
		filename: string,
		groupBy: string[] | undefined,
		aggregations: Aggregation[],
		where?: WhereClause[],
		sheet?: string,
	): Promise<TabularGroups>;
}

export class NoOpTabularEngine implements TabularEngine {
	private fail(): never {
		throw new Error("Tabular engine not configured");
	}
	async describe(): Promise<TabularSchema> {
		this.fail();
	}
	async head(): Promise<TabularRows> {
		this.fail();
	}
	async sample(): Promise<TabularRows> {
		this.fail();
	}
	async distinct(): Promise<{ column: string; values: unknown[] }> {
		this.fail();
	}
	async filter(): Promise<TabularRows> {
		this.fail();
	}
	async aggregate(): Promise<TabularGroups> {
		this.fail();
	}
}
