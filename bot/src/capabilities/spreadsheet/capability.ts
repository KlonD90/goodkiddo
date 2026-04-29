import type { AppConfig } from "../../config";
import { saveIncomingAttachment } from "../incoming/save_attachment";
import type {
	CapabilityInput,
	CapabilityResult,
	FileCapability,
	FileMetadata,
} from "../types";
import { SPREADSHEET_MAX_BYTES, TABULAR_INLINE_THRESHOLD_BYTES } from "./constants";
import { CsvParser } from "./csv_parser";
import { ExcelParser } from "./excel_parser";
import type { SpreadsheetParser } from "./parser";
import { renderSpreadsheet } from "./renderer";

export type SpreadsheetCapabilityOptions = {
	parser?: SpreadsheetParser;
};

const CSV_MIME_TYPES = new Set(["text/csv", "application/csv"]);
const EXCEL_MIME_TYPES = new Set([
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const CSV_FILENAME = /\.csv$/i;
const EXCEL_FILENAME = /\.(xlsx|xls)$/i;

export function createSpreadsheetCapability(
	config: AppConfig,
	options: SpreadsheetCapabilityOptions = {},
): FileCapability | null {
	if (config.enableSpreadsheets === false) return null;
	const parser = options.parser ?? createCombinedParser();

	return {
		name: "spreadsheet",
		canHandle,
		prevalidate,
		process: (input) => processSpreadsheet(parser, input),
	};
}

function canHandle(metadata: FileMetadata): boolean {
	const mime = metadata.mimeType;
	if (typeof mime === "string" && (CSV_MIME_TYPES.has(mime) || EXCEL_MIME_TYPES.has(mime))) {
		return true;
	}
	const filename = metadata.filename;
	if (typeof filename === "string" && (CSV_FILENAME.test(filename) || EXCEL_FILENAME.test(filename))) {
		return true;
	}
	return false;
}

function prevalidate(metadata: FileMetadata): CapabilityResult | null {
	if (metadata.byteSize === undefined) {
		return {
			ok: false,
			userMessage:
				"Spreadsheet file size is unknown. Please try again or send a different file.",
		};
	}
	if (metadata.byteSize > SPREADSHEET_MAX_BYTES) {
		return { ok: false, userMessage: "Spreadsheet is too large (max 10 MB)." };
	}
	return null;
}

async function processSpreadsheet(
	parser: SpreadsheetParser,
	input: CapabilityInput,
): Promise<CapabilityResult> {
	const filename = input.metadata.filename ?? "spreadsheet";
	const mimeType = input.metadata.mimeType ?? "";

	if (input.workspace !== undefined && input.bytes.length > TABULAR_INLINE_THRESHOLD_BYTES) {
		const ext = filename.includes(".") ? filename.split(".").pop()! : "csv";
		try {
			const { vfsPath } = await saveIncomingAttachment({
				backend: input.workspace,
				bytes: input.bytes,
				extension: ext,
			});
			const message =
				`Spreadsheet saved to \`${vfsPath}\`. ` +
				`Use \`tabular_describe\`, \`tabular_head\`, \`tabular_filter\`, or \`tabular_aggregate\` to query it.`;
			return {
				ok: true,
				value: {
					content: message,
					currentUserText: message,
				},
			};
		} catch {
			// fall through to inline rendering if save fails
		}
	}

	const result = await parser.parse(input.bytes, filename, mimeType);

	if (result.isCorrupt) {
		return {
			ok: false,
			userMessage: `Failed to read spreadsheet: ${result.errorMessage ?? "parsing failed"}`,
		};
	}

	if (result.isEmpty) {
		return {
			ok: false,
			userMessage: "This spreadsheet appears to be empty.",
		};
	}

	const rendered = renderSpreadsheet(result, filename);
	return {
		ok: true,
		value: {
			content: rendered,
			currentUserText: rendered,
		},
	};
}

function createCombinedParser(): SpreadsheetParser {
	const csv = new CsvParser();
	const excel = new ExcelParser();
	return {
		async parse(data, filename, mimeType) {
			if (mimeType === "text/csv" || filename.toLowerCase().endsWith(".csv")) {
				return csv.parse(data, filename, mimeType);
			}
			return excel.parse(data, filename, mimeType);
		},
	};
}
