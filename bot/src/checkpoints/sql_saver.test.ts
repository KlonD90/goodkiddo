import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckpointMetadata, emptyCheckpoint } from "@langchain/langgraph";
import { createDb, detectDialect } from "../db";
import { ForcedCheckpointStore } from "./forced_checkpoint_store";
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

describe("ForcedCheckpointStore", () => {
	test("create persists a forced checkpoint and readLatest returns it", async () => {
		const dbUrl = createTempDbUrl();
		const db = createDb(dbUrl);
		const store = new ForcedCheckpointStore(db);

		const record = await store.create({
			caller: "user-1",
			threadId: "thread-a",
			sourceBoundary: "new_thread",
			summaryPayload: JSON.stringify({ goal: "test", decisions: [] }),
		});

		expect(record.id).toBeTruthy();
		expect(record.caller).toBe("user-1");
		expect(record.threadId).toBe("thread-a");
		expect(record.sourceBoundary).toBe("new_thread");
		expect(record.summaryPayload).toBe(
			JSON.stringify({ goal: "test", decisions: [] }),
		);
		expect(record.createdAt).toBeTruthy();

		const latest = await store.readLatest("user-1", "thread-a");
		expect(latest?.id).toBe(record.id);
		expect(latest?.summaryPayload).toBe(record.summaryPayload);

		await db.close();
	});

	test("readLatest returns the most recent checkpoint when multiple exist", async () => {
		const dbUrl = createTempDbUrl();
		const db = createDb(dbUrl);
		const store = new ForcedCheckpointStore(db);

		await store.create({
			caller: "user-1",
			threadId: "thread-b",
			sourceBoundary: "token_limit",
			summaryPayload: "first",
		});
		// Small delay to ensure distinct created_at ordering
		await Bun.sleep(5);
		const second = await store.create({
			caller: "user-1",
			threadId: "thread-b",
			sourceBoundary: "message_limit",
			summaryPayload: "second",
		});

		const latest = await store.readLatest("user-1", "thread-b");
		expect(latest?.id).toBe(second.id);
		expect(latest?.summaryPayload).toBe("second");

		await db.close();
	});

	test("readLatest returns null when no checkpoint exists for caller+thread", async () => {
		const dbUrl = createTempDbUrl();
		const db = createDb(dbUrl);
		const store = new ForcedCheckpointStore(db);

		await store.create({
			caller: "user-1",
			threadId: "thread-c",
			sourceBoundary: "explicit",
			summaryPayload: "belongs to user-1",
		});

		const missing = await store.readLatest("user-2", "thread-c");
		expect(missing).toBeNull();

		const wrongThread = await store.readLatest("user-1", "thread-other");
		expect(wrongThread).toBeNull();

		await db.close();
	});

	test("caller and thread isolation: checkpoints from different callers do not bleed through", async () => {
		const dbUrl = createTempDbUrl();
		const db = createDb(dbUrl);
		const store = new ForcedCheckpointStore(db);

		await store.create({
			caller: "alice",
			threadId: "t1",
			sourceBoundary: "new_thread",
			summaryPayload: "alice-t1",
		});
		await store.create({
			caller: "bob",
			threadId: "t1",
			sourceBoundary: "new_thread",
			summaryPayload: "bob-t1",
		});
		await store.create({
			caller: "alice",
			threadId: "t2",
			sourceBoundary: "session_resume",
			summaryPayload: "alice-t2",
		});

		const aliceT1 = await store.readLatest("alice", "t1");
		const bobT1 = await store.readLatest("bob", "t1");
		const aliceT2 = await store.readLatest("alice", "t2");

		expect(aliceT1?.summaryPayload).toBe("alice-t1");
		expect(bobT1?.summaryPayload).toBe("bob-t1");
		expect(aliceT2?.summaryPayload).toBe("alice-t2");

		const aliceList = await store.listForThread("alice", "t1");
		expect(aliceList).toHaveLength(1);
		expect(aliceList[0]?.summaryPayload).toBe("alice-t1");

		await db.close();
	});

	test("listRecentForCaller returns recent checkpoints across threads for one caller", async () => {
		const dbUrl = createTempDbUrl();
		const db = createDb(dbUrl);
		const store = new ForcedCheckpointStore(db);

		await store.create({
			caller: "alice",
			threadId: "old-thread",
			sourceBoundary: "new_thread",
			summaryPayload: "old",
		});
		await Bun.sleep(5);
		const recent = await store.create({
			caller: "alice",
			threadId: "new-thread",
			sourceBoundary: "session_resume",
			summaryPayload: "recent",
		});
		await store.create({
			caller: "bob",
			threadId: "bob-thread",
			sourceBoundary: "new_thread",
			summaryPayload: "bob",
		});

		const records = await store.listRecentForCaller("alice", 1);

		expect(records).toHaveLength(1);
		expect(records[0]?.id).toBe(recent.id);
		expect(records[0]?.summaryPayload).toBe("recent");

		await db.close();
	});

	test("create gives same-millisecond checkpoints deterministic recent ordering", async () => {
		const dbUrl = createTempDbUrl();
		const db = createDb(dbUrl);
		const store = new ForcedCheckpointStore(db);
		const originalDateNow = Date.now;
		Date.now = () => Date.parse("2026-04-30T12:00:00.000Z");
		try {
			const first = await store.create({
				caller: "alice",
				threadId: "thread-a",
				sourceBoundary: "new_thread",
				summaryPayload: "a",
			});
			const second = await store.create({
				caller: "alice",
				threadId: "thread-b",
				sourceBoundary: "session_resume",
				summaryPayload: "b",
			});

			const records = await store.listRecentForCaller("alice", 2);

			expect(first.createdAt).toBe(second.createdAt);
			expect(records.map((record) => record.id)).toEqual([second.id, first.id]);
		} finally {
			Date.now = originalDateNow;
			await db.close();
		}
	});

	test("listRecentForCaller uses stable ordering when stored timestamps tie", async () => {
		const dbUrl = createTempDbUrl();
		const db = createDb(dbUrl);
		const store = new ForcedCheckpointStore(db);
		await store.ready();
		const createdAt = "2026-04-30T12:00:00.000Z";

		await db`
			INSERT INTO forced_checkpoints (
				id,
				caller,
				thread_id,
				created_at,
				created_order,
				source_boundary,
				summary_payload
			) VALUES (
				${"checkpoint-a"},
				${"alice"},
				${"thread-a"},
				${createdAt},
				${"000001"},
				${"new_thread"},
				${"a"}
			)
		`;
		await db`
			INSERT INTO forced_checkpoints (
				id,
				caller,
				thread_id,
				created_at,
				created_order,
				source_boundary,
				summary_payload
			) VALUES (
				${"checkpoint-b"},
				${"alice"},
				${"thread-b"},
				${createdAt},
				${"000002"},
				${"session_resume"},
				${"b"}
			)
		`;

		const records = await store.listRecentForCaller("alice", 2);

		expect(records.map((record) => record.id)).toEqual([
			"checkpoint-b",
			"checkpoint-a",
		]);

		await db.close();
	});

	test("listRecentForCaller keeps migrated timestamp ties deterministic", async () => {
		const dbUrl = createTempDbUrl();
		const db = createDb(dbUrl);
		const store = new ForcedCheckpointStore(db);
		await store.ready();
		const createdAt = "2026-04-30T12:00:00.000Z";

		await db`
			INSERT INTO forced_checkpoints (
				id,
				caller,
				thread_id,
				created_at,
				source_boundary,
				summary_payload
			) VALUES (
				${"checkpoint-a"},
				${"alice"},
				${"thread-a"},
				${createdAt},
				${"new_thread"},
				${"a"}
			)
		`;
		await db`
			INSERT INTO forced_checkpoints (
				id,
				caller,
				thread_id,
				created_at,
				source_boundary,
				summary_payload
			) VALUES (
				${"checkpoint-b"},
				${"alice"},
				${"thread-b"},
				${createdAt},
				${"session_resume"},
				${"b"}
			)
		`;

		const records = await store.listRecentForCaller("alice", 2);

		expect(records.map((record) => record.id)).toEqual([
			"checkpoint-b",
			"checkpoint-a",
		]);

		await db.close();
	});
});
