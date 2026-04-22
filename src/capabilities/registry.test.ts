import { describe, expect, test } from "bun:test";
import type { AttachmentBudgetConfig } from "./attachment_budget";
import { CapabilityRegistry } from "./registry";
import type {
	CapabilityInput,
	CapabilityResult,
	FileCapability,
	FileMetadata,
} from "./types";

const DEFAULT_BUDGET_CONFIG: AttachmentBudgetConfig = {
	maxContextWindowTokens: 20,
	reserveSummaryTokens: 2,
	reserveRecentTurnTokens: 2,
	reserveNextTurnTokens: 2,
};

function makeCapability(
	name: string,
	overrides: Partial<FileCapability> & {
		matches?: (m: FileMetadata) => boolean;
		result?: CapabilityResult;
		onProcess?: (input: CapabilityInput) => void;
	} = {},
): FileCapability {
	const matches = overrides.matches ?? (() => false);
	const result: CapabilityResult = overrides.result ?? {
		ok: true,
		value: { content: `${name}:processed`, currentUserText: `${name}:text` },
	};
	return {
		name,
		canHandle: (metadata) => matches(metadata),
		prevalidate: overrides.prevalidate,
		async process(input) {
			overrides.onProcess?.(input);
			return result;
		},
	};
}

describe("CapabilityRegistry", () => {
	test("match returns first capability whose canHandle returns true", () => {
		const a = makeCapability("a", { matches: () => false });
		const b = makeCapability("b", { matches: (m) => m.mimeType === "x/y" });
		const registry = new CapabilityRegistry([a, b]);

		expect(registry.match({ mimeType: "x/y" })?.name).toBe("b");
		expect(registry.match({ mimeType: "other" })).toBeNull();
	});

	test("handle rejects unsupported metadata with a user-facing message", async () => {
		const registry = new CapabilityRegistry([]);
		const result = await registry.handle(
			{ mimeType: "application/octet-stream", filename: "file.bin" },
			async () => new Uint8Array(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.userMessage).toBe(
				"Unsupported file type: application/octet-stream.",
			);
		}
	});

	test("handle falls back to filename when mimeType is absent in the unsupported message", async () => {
		const registry = new CapabilityRegistry([]);
		const result = await registry.handle(
			{ filename: "report.xyz" },
			async () => new Uint8Array(),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.userMessage).toBe("Unsupported file type: report.xyz.");
		}
	});

	test("handle returns the prevalidate error without calling download", async () => {
		let downloaded = false;
		const cap = makeCapability("a", {
			matches: () => true,
			prevalidate: () => ({ ok: false, userMessage: "too big" }),
		});
		const registry = new CapabilityRegistry([cap]);

		const result = await registry.handle({ mimeType: "x/y" }, async () => {
			downloaded = true;
			return new Uint8Array();
		});

		expect(downloaded).toBe(false);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.userMessage).toBe("too big");
	});

	test("handle wraps download failures with a user message", async () => {
		const cap = makeCapability("a", { matches: () => true });
		const registry = new CapabilityRegistry([cap]);
		const result = await registry.handle({ mimeType: "x/y" }, async () => {
			throw new Error("network blew up");
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.userMessage).toBe("Failed to download file: network blew up");
		}
	});

	test("handle forwards bytes and metadata to the matched capability", async () => {
		let captured: CapabilityInput | null = null;
		const cap = makeCapability("a", {
			matches: (m) => m.mimeType === "x/y",
			onProcess: (input) => {
				captured = input;
			},
		});
		const registry = new CapabilityRegistry([cap]);

		const bytes = Uint8Array.from([1, 2, 3]);
		const metadata: FileMetadata = { mimeType: "x/y", byteSize: 3 };
		const result = await registry.handle(metadata, async () => bytes);

		expect(result.ok).toBe(true);
		expect(captured).not.toBeNull();
		expect(captured!.bytes).toBe(bytes);
		expect(captured!.metadata).toBe(metadata);
	});

	test("handle leaves successful results unchanged when no budget is provided", async () => {
		const expected: CapabilityResult = {
			ok: true,
			value: { content: "small", currentUserText: "user text" },
		};
		const cap = makeCapability("voice", {
			matches: () => true,
			result: expected,
		});
		const registry = new CapabilityRegistry([cap]);

		const result = await registry.handle({ mimeType: "audio/ogg" }, async () => {
			return new Uint8Array([1]);
		});

		expect(result).toEqual(expected);
	});

	test("handle rejects oversized attachments with a user-facing message", async () => {
		let compactCalls = 0;
		const cap = makeCapability("pdf", {
			matches: () => true,
			result: {
				ok: true,
				value: {
					content: "x".repeat(33),
					currentUserText: "user text",
				},
			},
		});
		const registry = new CapabilityRegistry([cap]);

		const result = await registry.handle(
			{ mimeType: "application/pdf" },
			async () => new Uint8Array([1]),
			{
				config: {
					maxContextWindowTokens: 10,
					reserveSummaryTokens: 1,
					reserveRecentTurnTokens: 1,
					reserveNextTurnTokens: 2,
				},
				currentRuntimeTokens: 0,
				compact: async () => {
					compactCalls += 1;
				},
			},
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.userMessage).toBe(
				"This PDF is too large for a single turn (≈9 tokens, max 8). Please send a smaller file or split it.",
			);
		}
		expect(compactCalls).toBe(0);
	});

	test("handle compacts before returning a mid-range attachment", async () => {
		let compactCalls = 0;
		const expected: CapabilityResult = {
			ok: true,
			value: {
				content: "x".repeat(29),
				currentUserText: "user text",
			},
		};
		const cap = makeCapability("spreadsheet", {
			matches: () => true,
			result: expected,
		});
		const registry = new CapabilityRegistry([cap]);

		const result = await registry.handle(
			{ mimeType: "text/csv" },
			async () => new Uint8Array([1]),
			{
				config: {
					maxContextWindowTokens: 12,
					reserveSummaryTokens: 2,
					reserveRecentTurnTokens: 2,
					reserveNextTurnTokens: 2,
				},
				currentRuntimeTokens: 1,
				compact: async () => {
					compactCalls += 1;
				},
			},
		);

		expect(result).toEqual(expected);
		expect(compactCalls).toBe(1);
	});

	test("handle returns successful attachments directly when they fit the budget", async () => {
		let compactCalls = 0;
		const expected: CapabilityResult = {
			ok: true,
			value: {
				content: [
					{ type: "text", text: "x".repeat(24) },
					{
						type: "image",
						mimeType: "image/png",
						data: new Uint8Array([1, 2, 3]),
					},
				],
				currentUserText: "user text",
			},
		};
		const cap = makeCapability("voice", {
			matches: () => true,
			result: expected,
		});
		const registry = new CapabilityRegistry([cap]);

		const result = await registry.handle(
			{ mimeType: "audio/ogg" },
			async () => new Uint8Array([1]),
			{
				config: DEFAULT_BUDGET_CONFIG,
				currentRuntimeTokens: 4,
				compact: async () => {
					compactCalls += 1;
				},
			},
		);

		expect(result).toEqual(expected);
		expect(compactCalls).toBe(0);
	});

	test("processWith converts thrown errors into a user-facing result", async () => {
		const cap: FileCapability = {
			name: "boom",
			canHandle: () => true,
			async process() {
				throw new Error("kaboom");
			},
		};
		const registry = new CapabilityRegistry([cap]);

		const result = await registry.processWith(cap, {
			bytes: new Uint8Array(),
			metadata: {},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.userMessage).toBe("Failed to process boom: kaboom");
		}
	});
});
