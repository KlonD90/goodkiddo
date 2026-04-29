import { tool } from "langchain";
import type { StructuredTool } from "@langchain/core/tools";
import type { WorkspaceBackend } from "../../backends/types";
import type { TabularEngine } from "./engine";
import {
	aggregateSchema,
	describeSchema,
	distinctSchema,
	filterSchema,
	headSchema,
	sampleSchema,
} from "./schemas";
import type {
	AggregateInput,
	DescribeInput,
	DistinctInput,
	FilterInput,
	HeadInput,
	SampleInput,
} from "./schemas";

const PER_TOOL_TOKEN_CAP = 4000;
const TRUNCATION_HINT =
	"...truncated — narrow the filter or reduce limit to see more results";

function toWorkspacePath(path: string): string {
	return path.startsWith("/") ? path : `/${path}`;
}

function estimateTokens(s: string): number {
	return Math.ceil(s.length / 4);
}

function truncateRows<T>(
	rows: T[],
	serialize: (subset: T[]) => string,
): { rows: T[]; truncated: boolean } {
	const full = serialize(rows);
	if (estimateTokens(full) <= PER_TOOL_TOKEN_CAP) {
		return { rows, truncated: false };
	}
	// Binary-search to find the largest prefix that fits
	let lo = 0;
	let hi = rows.length;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (estimateTokens(serialize(rows.slice(0, mid))) <= PER_TOOL_TOKEN_CAP) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return { rows: rows.slice(0, lo), truncated: true };
}

async function fetchFileData(
	workspace: WorkspaceBackend,
	path: string,
): Promise<Uint8Array> {
	const results = await workspace.downloadFiles([path]);
	const file = results[0];
	if (!file || file.error) {
		throw new Error(file?.error === "file_not_found"
			? `File '${path}' not found`
			: (file?.error ?? `Failed to read '${path}'`));
	}
	if (!file.content) {
		throw new Error(`File '${path}' is empty or unreadable`);
	}
	return file.content;
}

export interface TabularToolOptions {
	engine: TabularEngine;
	workspace: WorkspaceBackend;
}

function wrapError(fn: () => Promise<string>): Promise<string> {
	return fn().catch((err) => {
		const message = err instanceof Error ? err.message : String(err);
		return `Error: ${message}`;
	});
}

export function createTabularDescribeTool({ engine, workspace }: TabularToolOptions) {
	return tool(
		({ path, sheet }: DescribeInput) =>
			wrapError(async () => {
				const wsPath = toWorkspacePath(path);
				const data = await fetchFileData(workspace, wsPath);
				const schema = await engine.describe(data, wsPath.split("/").pop() ?? path, sheet);
				return JSON.stringify(schema);
			}),
		{
			name: "tabular_describe",
			description:
				"Returns the schema of a tabular file (columns, dtypes, row count) without loading rows. " +
				"Supports .csv, .tsv, .xlsx, .xls files in the workspace. Use this before querying.",
			schema: describeSchema,
		},
	);
}

export function createTabularHeadTool({ engine, workspace }: TabularToolOptions) {
	return tool(
		({ path, n, sheet }: HeadInput) =>
			wrapError(async () => {
				const wsPath = toWorkspacePath(path);
				const data = await fetchFileData(workspace, wsPath);
				const result = await engine.head(data, wsPath.split("/").pop() ?? path, n, sheet);
				const { rows, truncated } = truncateRows(result.rows, (subset) =>
					JSON.stringify({ columns: result.columns, rows: subset }),
				);
				const out = JSON.stringify({ columns: result.columns, rows });
				return truncated ? `${out}\n${TRUNCATION_HINT}` : out;
			}),
		{
			name: "tabular_head",
			description:
				"Returns the first N rows of a tabular file (max 50). " +
				"Use tabular_describe first to see available columns.",
			schema: headSchema,
		},
	);
}

export function createTabularSampleTool({ engine, workspace }: TabularToolOptions) {
	return tool(
		({ path, n, sheet, seed }: SampleInput) =>
			wrapError(async () => {
				const wsPath = toWorkspacePath(path);
				const data = await fetchFileData(workspace, wsPath);
				const result = await engine.sample(data, wsPath.split("/").pop() ?? path, n, sheet, seed);
				const { rows, truncated } = truncateRows(result.rows, (subset) =>
					JSON.stringify({ columns: result.columns, rows: subset }),
				);
				const out = JSON.stringify({ columns: result.columns, rows });
				return truncated ? `${out}\n${TRUNCATION_HINT}` : out;
			}),
		{
			name: "tabular_sample",
			description:
				"Returns N randomly sampled rows from a tabular file (max 50). " +
				"Optionally pass a seed for reproducible results.",
			schema: sampleSchema,
		},
	);
}

export function createTabularDistinctTool({ engine, workspace }: TabularToolOptions) {
	return tool(
		({ path, column, limit, sheet }: DistinctInput) =>
			wrapError(async () => {
				const wsPath = toWorkspacePath(path);
				const data = await fetchFileData(workspace, wsPath);
				const result = await engine.distinct(
					data,
					wsPath.split("/").pop() ?? path,
					column,
					limit,
					sheet,
				);
				const serialized = JSON.stringify(result);
				if (estimateTokens(serialized) > PER_TOOL_TOKEN_CAP) {
					const { values, truncated } = truncateRows(result.values, (subset) =>
						JSON.stringify({ column: result.column, values: subset }),
					);
					const out = JSON.stringify({ column: result.column, values });
					return truncated ? `${out}\n${TRUNCATION_HINT}` : out;
				}
				return serialized;
			}),
		{
			name: "tabular_distinct",
			description:
				"Returns distinct values for a column in a tabular file (max 200 values). " +
				"Useful for understanding categorical distributions.",
			schema: distinctSchema,
		},
	);
}

export function createTabularFilterTool({ engine, workspace }: TabularToolOptions) {
	return tool(
		({ path, where, select, limit, sheet }: FilterInput) =>
			wrapError(async () => {
				const wsPath = toWorkspacePath(path);
				const data = await fetchFileData(workspace, wsPath);
				const result = await engine.filter(
					data,
					wsPath.split("/").pop() ?? path,
					where,
					select,
					limit,
					sheet,
				);
				const { rows, truncated } = truncateRows(result.rows, (subset) =>
					JSON.stringify({ columns: result.columns, rows: subset }),
				);
				const out = JSON.stringify({ columns: result.columns, rows });
				return truncated ? `${out}\n${TRUNCATION_HINT}` : out;
			}),
		{
			name: "tabular_filter",
			description:
				"Filters rows from a tabular file using structured conditions (max 100 rows). " +
				"Conditions are AND-combined. Supported operators: eq, ne, lt, lte, gt, gte, contains, in, between, isnull.",
			schema: filterSchema,
		},
	);
}

export function createTabularAggregateTool({ engine, workspace }: TabularToolOptions) {
	return tool(
		({ path, groupBy, aggregations, where, sheet }: AggregateInput) =>
			wrapError(async () => {
				const wsPath = toWorkspacePath(path);
				const data = await fetchFileData(workspace, wsPath);
				const result = await engine.aggregate(
					data,
					wsPath.split("/").pop() ?? path,
					groupBy,
					aggregations,
					where,
					sheet,
				);
				const { rows, truncated } = truncateRows(result.rows, (subset) =>
					JSON.stringify({ columns: result.columns, rows: subset }),
				);
				const out = JSON.stringify({ columns: result.columns, rows });
				return truncated ? `${out}\n${TRUNCATION_HINT}` : out;
			}),
		{
			name: "tabular_aggregate",
			description:
				"Aggregates rows from a tabular file with optional grouping. " +
				"Supported functions: count, sum, mean, min, max, median, stddev. " +
				"Results are capped at 1000 groups.",
			schema: aggregateSchema,
		},
	);
}

export function createTabularTools(
	engine: TabularEngine,
	workspace: WorkspaceBackend,
): StructuredTool[] {
	const opts: TabularToolOptions = { engine, workspace };
	return [
		createTabularDescribeTool(opts),
		createTabularHeadTool(opts),
		createTabularSampleTool(opts),
		createTabularDistinctTool(opts),
		createTabularFilterTool(opts),
		createTabularAggregateTool(opts),
	];
}
