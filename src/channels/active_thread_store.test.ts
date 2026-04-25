import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../db";
import { ActiveThreadStore } from "./active_thread_store";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function createStore(): {
	store: ActiveThreadStore;
	close: () => Promise<void>;
} {
	const dir = mkdtempSync(join(tmpdir(), "active-thread-store-"));
	tempDirs.push(dir);
	const db = createDb(`sqlite://${join(dir, "threads.sqlite")}`);
	return {
		store: new ActiveThreadStore(db),
		close: () => db.close(),
	};
}

describe("ActiveThreadStore", () => {
	test("returns the default thread id the first time a caller is seen", async () => {
		const { store, close } = createStore();
		expect(await store.getOrCreate("caller-1", "base-thread")).toBe(
			"base-thread",
		);
		await close();
	});

	test("persists updated thread ids across store instances", async () => {
		const dir = mkdtempSync(join(tmpdir(), "active-thread-store-shared-"));
		tempDirs.push(dir);
		const dbUrl = `sqlite://${join(dir, "threads.sqlite")}`;

		const firstDb = createDb(dbUrl);
		const first = new ActiveThreadStore(firstDb);
		await first.setActiveThread("caller-2", "rotated-thread");
		await firstDb.close();

		const secondDb = createDb(dbUrl);
		const second = new ActiveThreadStore(secondDb);
		expect(await second.getOrCreate("caller-2", "base-thread")).toBe(
			"rotated-thread",
		);
		await secondDb.close();
	});
});
