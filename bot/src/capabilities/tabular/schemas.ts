import { z } from "zod";
import type { WhereOperator, AggregationFn } from "./engine";

export const OPERATORS: readonly WhereOperator[] = [
	"eq",
	"ne",
	"lt",
	"lte",
	"gt",
	"gte",
	"contains",
	"in",
	"between",
	"isnull",
];

export const AGGREGATION_FNS: readonly AggregationFn[] = [
	"count",
	"sum",
	"mean",
	"min",
	"max",
	"median",
	"stddev",
];

const whereClauseSchema = z.object({
	column: z.string().min(1).describe("Column name to filter on"),
	op: z
		.enum(OPERATORS as [WhereOperator, ...WhereOperator[]])
		.describe("Filter operator"),
	value: z
		.unknown()
		.optional()
		.describe(
			"Filter value. Omit for isnull. Use an array for 'in' and 'between' operators.",
		),
});

const aggregationSchema = z.object({
	fn: z
		.enum(AGGREGATION_FNS as [AggregationFn, ...AggregationFn[]])
		.describe("Aggregation function"),
	column: z
		.string()
		.min(1)
		.optional()
		.describe("Column to aggregate (required for sum/mean/min/max/median/stddev)"),
	alias: z.string().min(1).optional().describe("Output column alias"),
});

export const describeSchema = z.object({
	path: z.string().min(1).describe("Workspace path to the tabular file"),
	sheet: z
		.string()
		.min(1)
		.optional()
		.describe("Sheet name for XLSX files (defaults to first sheet)"),
});

export const headSchema = z.object({
	path: z.string().min(1).describe("Workspace path to the tabular file"),
	n: z
		.number()
		.int()
		.positive()
		.max(50)
		.default(10)
		.describe("Number of rows to return (max 50)"),
	sheet: z.string().min(1).optional().describe("Sheet name for XLSX files"),
});

export const sampleSchema = z.object({
	path: z.string().min(1).describe("Workspace path to the tabular file"),
	n: z
		.number()
		.int()
		.positive()
		.max(50)
		.default(10)
		.describe("Number of rows to sample (max 50)"),
	sheet: z.string().min(1).optional().describe("Sheet name for XLSX files"),
	seed: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Random seed for reproducible sampling"),
});

export const distinctSchema = z.object({
	path: z.string().min(1).describe("Workspace path to the tabular file"),
	column: z.string().min(1).describe("Column to get distinct values for"),
	limit: z
		.number()
		.int()
		.positive()
		.max(200)
		.default(50)
		.describe("Maximum number of distinct values (max 200)"),
	sheet: z.string().min(1).optional().describe("Sheet name for XLSX files"),
});

export const filterSchema = z.object({
	path: z.string().min(1).describe("Workspace path to the tabular file"),
	where: z
		.array(whereClauseSchema)
		.describe("Filter conditions (AND-combined)"),
	select: z
		.array(z.string().min(1))
		.optional()
		.describe("Columns to return (all if omitted)"),
	limit: z
		.number()
		.int()
		.positive()
		.max(100)
		.default(50)
		.describe("Maximum rows to return (max 100)"),
	sheet: z.string().min(1).optional().describe("Sheet name for XLSX files"),
});

export const aggregateSchema = z.object({
	path: z.string().min(1).describe("Workspace path to the tabular file"),
	groupBy: z
		.array(z.string().min(1))
		.optional()
		.describe("Columns to group by (omit for a single aggregate over all rows)"),
	aggregations: z
		.array(aggregationSchema)
		.min(1)
		.describe("Aggregation operations to apply"),
	where: z
		.array(whereClauseSchema)
		.optional()
		.describe("Pre-aggregation filter conditions"),
	sheet: z.string().min(1).optional().describe("Sheet name for XLSX files"),
});

export type DescribeInput = z.infer<typeof describeSchema>;
export type HeadInput = z.infer<typeof headSchema>;
export type SampleInput = z.infer<typeof sampleSchema>;
export type DistinctInput = z.infer<typeof distinctSchema>;
export type FilterInput = z.infer<typeof filterSchema>;
export type AggregateInput = z.infer<typeof aggregateSchema>;
