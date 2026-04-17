import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckpointMetadata, emptyCheckpoint } from "@langchain/langgraph";
import { BunSqliteSaver } from "./bun_sqlite_saver";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "bun-saver-"));
	tempDirs.push(dir);
	return join(dir, "checkpoints.sqlite");
}

function createMetadata(step: number): CheckpointMetadata {
	return {
		source: "loop",
		step,
		parents: {},
	};
}

describe("BunSqliteSaver", () => {
	test("persists checkpoints across saver instances", async () => {
		const dbPath = createTempDbPath();
		const threadConfig = { configurable: { thread_id: "thread-1" } };
		const first = new BunSqliteSaver(dbPath);

		const checkpoint = emptyCheckpoint();
		checkpoint.channel_values = {
			messages: [{ role: "user", content: "Kenshiro has black hair." }],
		};
		checkpoint.channel_versions = { messages: 1 };
		checkpoint.versions_seen = { __input__: { messages: 1 } };

		const writtenConfig = await first.put(
			threadConfig,
			checkpoint,
			createMetadata(1),
			{},
		);
		first.close();

		const second = new BunSqliteSaver(dbPath);
		const tuple = await second.getTuple(threadConfig);
		const explicitTuple = await second.getTuple(writtenConfig);
		second.close();

		expect(tuple?.checkpoint.id).toBe(checkpoint.id);
		expect(tuple?.checkpoint.channel_values.messages).toEqual([
			{ role: "user", content: "Kenshiro has black hair." },
		]);
		expect(tuple?.metadata?.step).toBe(1);
		expect(explicitTuple?.checkpoint.id).toBe(checkpoint.id);
	});

	test("round-trips pending writes and deleteThread removes them", async () => {
		const dbPath = createTempDbPath();
		const saver = new BunSqliteSaver(dbPath);
		const checkpoint = emptyCheckpoint();
		const writeConfig = await saver.put(
			{ configurable: { thread_id: "thread-2" } },
			checkpoint,
			createMetadata(2),
			{},
		);

		await saver.putWrites(
			writeConfig,
			[
				["messages", { role: "assistant", content: "Shin has white hair." }],
				["__error__", { message: "ignored" }],
			],
			"task-1",
		);

		const tuple = await saver.getTuple(writeConfig);
		expect(tuple?.pendingWrites).toEqual([
			["task-1", "__error__", { message: "ignored" }],
			[
				"task-1",
				"messages",
				{ role: "assistant", content: "Shin has white hair." },
			],
		]);

		await saver.deleteThread("thread-2");
		const deleted = await saver.getTuple({
			configurable: { thread_id: "thread-2" },
		});
		saver.close();

		expect(deleted).toBeUndefined();
	});
});
