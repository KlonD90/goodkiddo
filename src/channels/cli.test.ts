import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { extractLocaleFromCli, resolveLocale } from "../i18n/locale";
import { PermissionsStore } from "../permissions/store";
import type { Caller } from "../permissions/types";
import { createStatusEmitter } from "../tools/status_emitter";
import { CliOutboundChannel, seedCliUser } from "./cli";
import { buildSessionRuntimeMessages } from "./shared";

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
			tier: "paid",
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

describe("cli status emitter", () => {
	test("createStatusEmitter from CliOutboundChannel emits to stream", async () => {
		const stream = new PassThrough();
		const chunks: string[] = [];
		stream.on("data", (chunk) => chunks.push(chunk.toString()));

		const outbound = new CliOutboundChannel(stream);
		const emitter = createStatusEmitter(outbound);

		await emitter.emit("cli:tester", "Reading a.md");

		expect(chunks).toEqual(["[status] Reading a.md\n"]);
	});

	test("resolveLocale extracts locale from LANG environment variable when LC_ALL is unset", () => {
		const originalLang = process.env.LANG;
		const originalLcAll = process.env.LC_ALL;
		try {
			delete process.env.LC_ALL;
			process.env.LANG = "ru_RU.UTF-8";
			const hint = extractLocaleFromCli();
			const locale = resolveLocale(hint);

			expect(hint).toBe("ru");
			expect(locale).toBe("ru");
		} finally {
			process.env.LANG = originalLang ?? "";
			if (originalLcAll !== undefined) {
				process.env.LC_ALL = originalLcAll;
			}
		}
	});

	test("resolveLocale falls back to en for unknown locale", () => {
		const originalLang = process.env.LANG;
		const originalLcAll = process.env.LC_ALL;
		try {
			delete process.env.LC_ALL;
			process.env.LANG = "xx_YY.UTF-8";
			const hint = extractLocaleFromCli();
			const locale = resolveLocale(hint);

			expect(hint).toBe("xx");
			expect(locale).toBe("en");
		} finally {
			process.env.LANG = originalLang ?? "";
			if (originalLcAll !== undefined) {
				process.env.LC_ALL = originalLcAll;
			}
		}
	});

	test("resolveLocale uses LC_ALL over LANG", () => {
		const originalLang = process.env.LANG;
		const originalLcAll = process.env.LC_ALL;
		try {
			process.env.LANG = "en_US.UTF-8";
			process.env.LC_ALL = "es_ES.UTF-8";
			const hint = extractLocaleFromCli();

			expect(hint).toBe("es");
		} finally {
			process.env.LANG = originalLang ?? "";
			process.env.LC_ALL = originalLcAll ?? "";
		}
	});

	test("buildSessionRuntimeMessages appends compacted runtime context for shared channel sessions", () => {
		const messages = buildSessionRuntimeMessages(
			{
				pendingCompactionSeed: {
					summary: {
						current_goal: "Ship release",
						decisions: ["Use draft PR"],
						constraints: [],
						unfinished_work: ["write tests"],
						pending_approvals: [],
						important_artifacts: ["docs/plan.md"],
					},
					recentTurns: [{ role: "user", content: "latest turn" }],
				},
				pendingTaskCheckContext: "Auto-completed task.",
			},
			[{ role: "assistant", content: "stored reply" }],
		);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			role: "assistant",
			content: "stored reply",
		});
		expect(messages[1]).toMatchObject({
			role: "system",
		});
		expect(messages[1]?.content).toContain("Compacted Conversation Context");
		expect(messages[1]?.content).toContain("Auto-completed task.");
	});
});
