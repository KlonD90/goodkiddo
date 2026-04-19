import { afterEach, describe, expect, test } from "bun:test";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import { seedCliUser } from "./cli";

let db: InstanceType<typeof Bun.SQL>;
let store: PermissionsStore;

const caller: Caller = {
	id: "cli:tester",
	entrypoint: "cli",
	externalId: "tester",
	displayName: "Tester",
};

afterEach(async () => {
	await db?.close();
});

describe("cli channel", () => {
	test("seedCliUser creates the caller record", async () => {
		db = new Bun.SQL("sqlite://:memory:");
		store = new PermissionsStore({ db, dialect: "sqlite" });
		await seedCliUser(store, caller);

		expect(await store.getUser("cli", "tester")).toEqual({
			id: "cli:tester",
			entrypoint: "cli",
			externalId: "tester",
			displayName: "Tester",
			status: "active",
			createdAt: expect.any(Number),
		});
	});

	test("seedCliUser leaves permissive mode to the global default policy", async () => {
		db = new Bun.SQL("sqlite://:memory:");
		store = new PermissionsStore({ db, dialect: "sqlite" });
		await seedCliUser(store, caller);
		await seedCliUser(store, caller);

		expect(await store.listRulesForUser(caller.id)).toEqual([]);
	});
});
