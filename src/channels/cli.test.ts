import { afterEach, describe, expect, test } from "bun:test";
import { seedCliUser } from "./cli";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";

let store: PermissionsStore;

const caller: Caller = {
	id: "cli:tester",
	entrypoint: "cli",
	externalId: "tester",
	displayName: "Tester",
};

afterEach(() => {
	store?.close();
});

describe("cli channel", () => {
	test("seedCliUser creates the caller record", () => {
		store = new PermissionsStore({ dbPath: ":memory:" });
		seedCliUser(store, caller);

		expect(store.getUser("cli", "tester")).toEqual({
			id: "cli:tester",
			entrypoint: "cli",
			externalId: "tester",
			displayName: "Tester",
			status: "active",
			createdAt: expect.any(Number),
		});
	});

	test("seedCliUser leaves permissive mode to the global default policy", () => {
		store = new PermissionsStore({ dbPath: ":memory:" });
		seedCliUser(store, caller);
		seedCliUser(store, caller);

		expect(store.listRulesForUser(caller.id)).toEqual([]);
	});
});
