import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import type { ImageUnderstandingProvider } from "../capabilities/image/types";
import { saveIncomingAttachment } from "../capabilities/incoming/save_attachment";
import { createDb, detectDialect } from "../db";
import { createUnderstandImageTool } from "./image_understanding_tool";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

type Invokable = { invoke: (input: unknown) => Promise<string> };

function callTool(tool: unknown, input: unknown): Promise<string> {
	return (tool as Invokable).invoke(input);
}

interface ProviderCall {
	prompt: string;
	bytes: Uint8Array;
	extension: string;
}

function fakeProvider(
	responder: (call: ProviderCall) => Promise<string> | string,
): { provider: ImageUnderstandingProvider; calls: ProviderCall[] } {
	const calls: ProviderCall[] = [];
	const provider: ImageUnderstandingProvider = {
		async understand(input) {
			const call = {
				prompt: input.prompt,
				bytes: input.bytes,
				extension: input.extension,
			};
			calls.push(call);
			return { text: await responder(call) };
		},
		async close() {},
	};
	return { provider, calls };
}

describe("understand_image tool", () => {
	test("reads bytes from /incoming/, calls the provider, returns text", async () => {
		const backend = createBackend("uit-1");
		const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
		const { vfsPath } = await saveIncomingAttachment({
			backend,
			bytes,
			extension: "jpg",
		});

		const { provider, calls } = fakeProvider((call) => {
			expect(Array.from(call.bytes)).toEqual(Array.from(bytes));
			expect(call.extension).toBe("jpg");
			return "A red apple.";
		});

		const tool = createUnderstandImageTool({ provider, backend });
		const result = await callTool(tool, {
			prompt: "what is this?",
			image_path: vfsPath,
		});

		expect(result).toBe("A red apple.");
		expect(calls).toHaveLength(1);
		expect(calls[0].prompt).toBe("what is this?");
	});

	test("rejects paths outside /incoming/", async () => {
		const backend = createBackend("uit-2");
		const { provider, calls } = fakeProvider(() => "should-not-be-called");

		const tool = createUnderstandImageTool({ provider, backend });
		const result = await callTool(tool, {
			prompt: "x",
			image_path: "/memory/MEMORY.md",
		});

		expect(result.startsWith("Image analysis failed")).toBe(true);
		expect(result).toContain("/incoming/");
		expect(calls).toHaveLength(0);
	});

	test("rejects path traversal attempts", async () => {
		const backend = createBackend("uit-3");
		const { provider, calls } = fakeProvider(() => "should-not-be-called");

		const tool = createUnderstandImageTool({ provider, backend });
		const result = await callTool(tool, {
			prompt: "x",
			image_path: "/incoming/../etc/passwd",
		});

		expect(result.startsWith("Image analysis failed")).toBe(true);
		expect(calls).toHaveLength(0);
	});

	test("returns failure string when the file is missing", async () => {
		const backend = createBackend("uit-4");
		const { provider, calls } = fakeProvider(() => "should-not-be-called");

		const tool = createUnderstandImageTool({ provider, backend });
		const result = await callTool(tool, {
			prompt: "x",
			image_path: "/incoming/missing-file.jpg",
		});

		expect(result.startsWith("Image analysis failed")).toBe(true);
		expect(calls).toHaveLength(0);
	});

	test("converts provider exceptions into failure strings", async () => {
		const backend = createBackend("uit-5");
		const bytes = new Uint8Array([1, 2, 3]);
		const { vfsPath } = await saveIncomingAttachment({
			backend,
			bytes,
			extension: "png",
		});

		const provider: ImageUnderstandingProvider = {
			async understand() {
				throw new Error("upstream timeout");
			},
			async close() {},
		};

		const tool = createUnderstandImageTool({ provider, backend });
		const result = await callTool(tool, {
			prompt: "x",
			image_path: vfsPath,
		});

		expect(result).toBe("Image analysis failed: upstream timeout");
	});
});
