import { describe, expect, test } from "bun:test";
import type { BackendProtocol, FileData } from "deepagents";
import { getMemoryPromptCharCap } from "./layout";
import { composeMemorySnapshot } from "./session_loader";

function createMemoryBackend(
	contents: Record<string, string>,
): BackendProtocol {
	return {
		readRaw: async (path: string): Promise<FileData> => ({
			content: contents[path] ?? "",
			mimeType: "text/plain",
			created_at: new Date().toISOString(),
			modified_at: new Date().toISOString(),
		}),
	} as unknown as BackendProtocol;
}

describe("getMemoryPromptCharCap", () => {
	test("defaults to 24000 characters", () => {
		const previous = process.env.MEMORY_PROMPT_CHAR_CAP;
		delete process.env.MEMORY_PROMPT_CHAR_CAP;
		try {
			expect(getMemoryPromptCharCap()).toBe(24000);
		} finally {
			if (previous === undefined) {
				delete process.env.MEMORY_PROMPT_CHAR_CAP;
			} else {
				process.env.MEMORY_PROMPT_CHAR_CAP = previous;
			}
		}
	});

	test("reads the cap from MEMORY_PROMPT_CHAR_CAP", () => {
		const previous = process.env.MEMORY_PROMPT_CHAR_CAP;
		process.env.MEMORY_PROMPT_CHAR_CAP = "12345";
		try {
			expect(getMemoryPromptCharCap()).toBe(12345);
		} finally {
			if (previous === undefined) {
				delete process.env.MEMORY_PROMPT_CHAR_CAP;
			} else {
				process.env.MEMORY_PROMPT_CHAR_CAP = previous;
			}
		}
	});

	test("falls back to the default for invalid env values", () => {
		const previous = process.env.MEMORY_PROMPT_CHAR_CAP;
		process.env.MEMORY_PROMPT_CHAR_CAP = "not-a-number";
		try {
			expect(getMemoryPromptCharCap()).toBe(24000);
		} finally {
			if (previous === undefined) {
				delete process.env.MEMORY_PROMPT_CHAR_CAP;
			} else {
				process.env.MEMORY_PROMPT_CHAR_CAP = previous;
			}
		}
	});
});

describe("composeMemorySnapshot", () => {
	test("truncates memory snapshot to the configured cap", async () => {
		const previous = process.env.MEMORY_PROMPT_CHAR_CAP;
		process.env.MEMORY_PROMPT_CHAR_CAP = "200";
		try {
			const backend = createMemoryBackend({
				"/memory/MEMORY.md": Array.from(
					{ length: 50 },
					(_, i) => `line ${i + 1} content`,
				).join("\n"),
				"/memory/USER.md": "",
				"/skills/SKILLS.md": "",
			});
			const snapshot = await composeMemorySnapshot(backend);
			expect(snapshot.length).toBeLessThanOrEqual(200 + 200); // cap + generous suffix headroom
			expect(snapshot).toContain("## Current memory");
			expect(snapshot).toContain("truncated");
		} finally {
			if (previous === undefined) {
				delete process.env.MEMORY_PROMPT_CHAR_CAP;
			} else {
				process.env.MEMORY_PROMPT_CHAR_CAP = previous;
			}
		}
	});
});
