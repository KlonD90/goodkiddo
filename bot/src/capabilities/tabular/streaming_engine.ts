import { parse } from "csv-parse";
import * as XLSX from "xlsx";
import type {
	Aggregation,
	AggregationFn,
	TabularEngine,
	TabularGroups,
	TabularRows,
	TabularSchema,
	WhereClause,
	WhereOperator,
} from "./engine";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ParsedSheet = {
	name: string;
	headers: string[];
	rows: string[][];
};

function isXlsx(filename: string): boolean {
	const lower = filename.toLowerCase();
	return lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".xlsm");
}

function isCsv(filename: string): boolean {
	const lower = filename.toLowerCase();
	return lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".tab");
}

async function parseCsvText(text: string): Promise<string[][]> {
	return new Promise((resolve, reject) => {
		const firstLines = text.split("\n").slice(0, 5).join("\n");
		const delimiters = [",", ";", "\t"];
		let maxCount = 0;
		let delimiter = ",";
		for (const d of delimiters) {
			const count = firstLines.split(d).length - 1;
			if (count > maxCount) {
				maxCount = count;
				delimiter = d;
			}
		}

		const records: string[][] = [];
		const parser = parse(text, {
			delimiter,
			quote: '"',
			escape: '"',
			skip_empty_lines: true,
			trim: true,
		});
		parser.on("readable", function () {
			let record: string[] | null;
			while (true) {
				record = (parser as unknown as { read(): string[] | null }).read();
				if (record === null) break;
				records.push(record);
			}
		});
		parser.on("error", reject);
		parser.on("end", () => resolve(records));
	});
}

function parseXlsxData(data: Uint8Array, sheetName?: string): ParsedSheet[] {
	const workbook = XLSX.read(data, { type: "array" });
	const names = workbook.SheetNames;
	const targetNames =
		sheetName !== undefined ? [sheetName] : names;

	const sheets: ParsedSheet[] = [];
	for (const name of targetNames) {
		if (!names.includes(name)) {
			throw new Error(`Sheet "${name}" not found. Available: ${names.join(", ")}`);
		}
		const ws = workbook.Sheets[name];
		const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
		if (raw.length === 0) {
			sheets.push({ name, headers: [], rows: [] });
			continue;
		}
		const headers = (raw[0] as unknown[]).map((h) => String(h ?? ""));
		const rows = raw.slice(1).map((row) => {
			const arr = row as unknown[];
			return headers.map((_, i) => String(arr[i] ?? ""));
		});
		sheets.push({ name, headers, rows });
	}
	return sheets;
}

async function loadSheet(
	data: Uint8Array,
	filename: string,
	sheet?: string,
): Promise<ParsedSheet> {
	if (isXlsx(filename)) {
		const sheets = parseXlsxData(data, sheet);
		if (sheets.length === 0) throw new Error("No sheets found");
		return sheets[0];
	}
	if (isCsv(filename)) {
		if (sheet !== undefined && sheet !== "Sheet1") {
			throw new Error(`CSV files have only one sheet ("Sheet1"), got "${sheet}"`);
		}
		const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
		const records = await parseCsvText(text);
		if (records.length === 0) {
			return { name: "Sheet1", headers: [], rows: [] };
		}
		const headers = records[0].map((h) => h.trim());
		const rows = records.slice(1);
		return { name: "Sheet1", headers, rows };
	}
	throw new Error(
		`Unsupported file format: ${filename}. Supported: CSV (.csv, .tsv), Excel (.xlsx, .xls, .xlsm)`,
	);
}

function coerce(v: unknown): unknown {
	if (v === null || v === undefined || v === "") return null;
	const s = String(v).trim();
	if (s === "") return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : s;
}

function inferDtype(values: string[]): string {
	const nonEmpty = values.filter((v) => v !== "");
	if (nonEmpty.length === 0) return "string";
	return nonEmpty.every((v) => Number.isFinite(Number(v))) ? "number" : "string";
}

function requireColumn(headers: string[], col: string): number {
	const idx = headers.indexOf(col);
	if (idx === -1) {
		throw new Error(
			`Column "${col}" not found. Available columns: ${headers.join(", ")}`,
		);
	}
	return idx;
}

function evalCondition(
	rawValue: string,
	op: WhereOperator,
	clauseValue: unknown,
): boolean {
	const v = coerce(rawValue);
	switch (op) {
		case "isnull":
			return v === null;
		case "eq":
			return v === clauseValue || String(rawValue) === String(clauseValue);
		case "ne":
			return v !== clauseValue && String(rawValue) !== String(clauseValue);
		case "lt":
			return Number(rawValue) < Number(clauseValue);
		case "lte":
			return Number(rawValue) <= Number(clauseValue);
		case "gt":
			return Number(rawValue) > Number(clauseValue);
		case "gte":
			return Number(rawValue) >= Number(clauseValue);
		case "contains":
			return String(rawValue).includes(String(clauseValue ?? ""));
		case "in":
			return (
				Array.isArray(clauseValue) &&
				clauseValue.some(
					(cv) => v === cv || String(rawValue) === String(cv),
				)
			);
		case "between": {
			if (!Array.isArray(clauseValue) || clauseValue.length < 2) return false;
			const n = Number(rawValue);
			return (
				Number.isFinite(n) &&
				n >= Number(clauseValue[0]) &&
				n <= Number(clauseValue[1])
			);
		}
	}
}

function applyWhere(headers: string[], rows: string[][], where: WhereClause[]): string[][] {
	if (where.length === 0) return rows;
	return rows.filter((row) =>
		where.every((clause) => {
			const idx = requireColumn(headers, clause.column);
			return evalCondition(row[idx] ?? "", clause.op, clause.value);
		}),
	);
}

function computeAgg(values: string[], fn: AggregationFn): unknown {
	if (fn === "count") return values.length;
	const nums = values
		.map((v) => Number(v))
		.filter((n) => Number.isFinite(n));
	if (nums.length === 0) return null;
	switch (fn) {
		case "sum":
			return nums.reduce((a, b) => a + b, 0);
		case "mean":
			return nums.reduce((a, b) => a + b, 0) / nums.length;
		case "min":
			return Math.min(...nums);
		case "max":
			return Math.max(...nums);
		case "median": {
			const sorted = [...nums].sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			return sorted.length % 2 === 0
				? (sorted[mid - 1] + sorted[mid]) / 2
				: sorted[mid];
		}
		case "stddev": {
			if (nums.length < 2) return null;
			const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
			const variance =
				nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1);
			return Math.sqrt(variance);
		}
	}
}

function mulberry32(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------
// StreamingTabularEngine
// ---------------------------------------------------------------------------

export class StreamingTabularEngine implements TabularEngine {
	async describe(
		data: Uint8Array,
		filename: string,
		sheet?: string,
	): Promise<TabularSchema> {
		const parsed = await loadSheet(data, filename, sheet);
		const columns = parsed.headers.map((name, i) => ({
			name,
			dtype: inferDtype(parsed.rows.map((r) => r[i] ?? "")),
		}));
		return {
			path: filename,
			sheet: parsed.name,
			columns,
			rowCount: parsed.rows.length,
		};
	}

	async head(
		data: Uint8Array,
		filename: string,
		n: number,
		sheet?: string,
	): Promise<TabularRows> {
		const parsed = await loadSheet(data, filename, sheet);
		return {
			columns: parsed.headers,
			rows: parsed.rows.slice(0, n),
		};
	}

	async sample(
		data: Uint8Array,
		filename: string,
		n: number,
		sheet?: string,
		seed?: number,
	): Promise<TabularRows> {
		const parsed = await loadSheet(data, filename, sheet);
		const rows = parsed.rows;
		if (rows.length <= n) {
			return { columns: parsed.headers, rows };
		}
		// Reservoir sampling
		const rng = mulberry32(seed ?? 0);
		const reservoir = rows.slice(0, n);
		for (let i = n; i < rows.length; i++) {
			const j = Math.floor(rng() * (i + 1));
			if (j < n) {
				reservoir[j] = rows[i];
			}
		}
		return { columns: parsed.headers, rows: reservoir };
	}

	async distinct(
		data: Uint8Array,
		filename: string,
		column: string,
		limit: number,
		sheet?: string,
	): Promise<{ column: string; values: unknown[] }> {
		const parsed = await loadSheet(data, filename, sheet);
		const idx = requireColumn(parsed.headers, column);
		const seen = new Set<string>();
		const values: unknown[] = [];
		for (const row of parsed.rows) {
			const v = row[idx] ?? "";
			if (!seen.has(v)) {
				seen.add(v);
				values.push(coerce(v) ?? "");
				if (values.length >= limit) break;
			}
		}
		return { column, values };
	}

	async filter(
		data: Uint8Array,
		filename: string,
		where: WhereClause[],
		select: string[] | undefined,
		limit: number,
		sheet?: string,
	): Promise<TabularRows> {
		const parsed = await loadSheet(data, filename, sheet);
		const filtered = applyWhere(parsed.headers, parsed.rows, where);
		const sliced = filtered.slice(0, limit);

		if (!select || select.length === 0) {
			return { columns: parsed.headers, rows: sliced };
		}

		const indices = select.map((col) => requireColumn(parsed.headers, col));
		return {
			columns: select,
			rows: sliced.map((row) => indices.map((i) => coerce(row[i] ?? ""))),
		};
	}

	async aggregate(
		data: Uint8Array,
		filename: string,
		groupBy: string[] | undefined,
		aggregations: Aggregation[],
		where?: WhereClause[],
		sheet?: string,
	): Promise<TabularGroups> {
		const GROUP_CAP = 1000;
		const parsed = await loadSheet(data, filename, sheet);
		const rows = where
			? applyWhere(parsed.headers, parsed.rows, where)
			: parsed.rows;

		const aggColumns = aggregations.map((a) => {
			if (a.alias) return a.alias;
			return a.column ? `${a.fn}(${a.column})` : a.fn;
		});
		const columns = [...(groupBy ?? []), ...aggColumns];

		if (!groupBy || groupBy.length === 0) {
			// Single aggregate over all rows
			const record: Record<string, unknown> = {};
			for (const agg of aggregations) {
				const key = agg.alias ?? (agg.column ? `${agg.fn}(${agg.column})` : agg.fn);
				let values: string[];
				if (agg.column) {
					const idx = requireColumn(parsed.headers, agg.column);
					values = rows.map((r) => r[idx] ?? "");
				} else {
					values = rows.map(() => "1");
				}
				record[key] = computeAgg(values, agg.fn);
			}
			return { columns, rows: [record] };
		}

		const groupIndices = groupBy.map((col) =>
			requireColumn(parsed.headers, col),
		);

		// Group rows
		const groupMap = new Map<string, string[][]>();
		for (const row of rows) {
			const key = groupIndices.map((i) => row[i] ?? "").join("\0");
			const bucket = groupMap.get(key);
			if (bucket) {
				bucket.push(row);
			} else {
				if (groupMap.size >= GROUP_CAP) continue;
				groupMap.set(key, [row]);
			}
		}

		const resultRows: Record<string, unknown>[] = [];
		for (const [, bucket] of groupMap) {
			const record: Record<string, unknown> = {};
			for (const [colIdx, col] of groupBy.entries()) {
				const headerIdx = groupIndices[colIdx];
				record[col] = coerce(bucket[0][headerIdx] ?? "") ?? "";
			}
			for (const agg of aggregations) {
				const key = agg.alias ?? (agg.column ? `${agg.fn}(${agg.column})` : agg.fn);
				let values: string[];
				if (agg.column) {
					const idx = requireColumn(parsed.headers, agg.column);
					values = bucket.map((r) => r[idx] ?? "");
				} else {
					values = bucket.map(() => "1");
				}
				record[key] = computeAgg(values, agg.fn);
			}
			resultRows.push(record);
		}

		return { columns, rows: resultRows };
	}
}
