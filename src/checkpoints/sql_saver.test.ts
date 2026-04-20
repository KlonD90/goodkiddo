import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckpointMetadata, emptyCheckpoint } from "@langchain/langgraph";
import { createDb, detectDialect } from "../db";
import { SqlSaver } from "./sql_saver";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDbUrl(): string {
	const dir = mkdtempSync(join(tmpdir(), "sql-saver-"));
	tempDirs.push(dir);
	return `sqlite://${join(dir, "checkpoints.sqlite")}`;
}

function createMetadata(step: number): CheckpointMetadata {
	return {
		source: "loop",
		step,
		parents: {},
	};
}

describe("SqlSaver", () => {
	test("persists checkpoints across saver instances", async () => {
		const dbUrl = createTempDbUrl();
		const threadConfig = { configurable: { thread_id: "thread-1" } };
		const firstDb = createDb(dbUrl);
		const first = new SqlSaver(firstDb, detectDialect(dbUrl));

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
		);
		await firstDb.close();

		const secondDb = createDb(dbUrl);
		const second = new SqlSaver(secondDb, detectDialect(dbUrl));
		const tuple = await second.getTuple(threadConfig);
		const explicitTuple = await second.getTuple(writtenConfig);
		await secondDb.close();

		expect(tuple?.checkpoint.id).toBe(checkpoint.id);
		expect(tuple?.checkpoint.channel_values.messages).toEqual([
			{ role: "user", content: "Kenshiro has black hair." },
		]);
		expect(tuple?.metadata?.step).toBe(1);
		expect(explicitTuple?.checkpoint.id).toBe(checkpoint.id);
	});

	test("round-trips pending writes and deleteThread removes them", async () => {
		const dbUrl = createTempDbUrl();
		const db = createDb(dbUrl);
		const saver = new SqlSaver(db, detectDialect(dbUrl));
		const checkpoint = emptyCheckpoint();
		const writeConfig = await saver.put(
			{ configurable: { thread_id: "thread-2" } },
			checkpoint,
			createMetadata(2),
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
		await db.close();

		expect(deleted).toBeUndefined();
	});
});
