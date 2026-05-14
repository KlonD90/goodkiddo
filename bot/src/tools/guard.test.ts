import { describe, expect, test } from "bun:test";
import { tool } from "langchain";
import { z } from "zod";
import type { Caller } from "../permissions/types";
import { wrapToolWithGuard } from "./guard";
import type { StatusEmitter } from "./status_emitter";

class FakeStatusEmitter implements StatusEmitter {
	public calls: Array<{ callerId: string; message: string }> = [];

	async emit(callerId: string, message: string): Promise<void> {
		this.calls.push({ callerId, message });
	}
}

const caller: Caller = {
	id: "cli:test",
	entrypoint: "cli",
	externalId: "test",
};

const sampleTool = () =>
	tool(async (input: { value: string }) => `ran:${input.value}`, {
		name: "sample",
		description: "Sample tool for tests.",
		schema: z.object({ value: z.string() }),
	});

describe("wrapToolWithGuard", () => {
	test("runs tools without policy checks", async () => {
		const wrapped = wrapToolWithGuard(sampleTool(), { caller });

		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			value: "x",
		});

		expect(result).toBe("ran:x");
	});

	test("emits status separately from tool output", async () => {
		const emitter = new FakeStatusEmitter();
		const wrapped = wrapToolWithGuard(
			tool(async (input: { file_path: string }) => `read:${input.file_path}`, {
				name: "read_file",
				description: "Read a file",
				schema: z.object({ file_path: z.string() }),
			}),
			{
				caller,
				statusEmitter: emitter,
				locale: "en",
			},
		);

		const result = await (wrapped.invoke as (i: unknown) => Promise<unknown>)({
			file_path: "/notes.md",
		});

		expect(result).toBe("read:/notes.md");
		expect(emitter.calls).toEqual([
			{ callerId: "cli:test", message: "Reading /notes.md" },
		]);
	});
});
