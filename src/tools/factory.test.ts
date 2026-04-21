import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import type { StatusEmitter } from "./status_emitter";
import { createExecutionToolset } from "./factory";
import type { SupportedLocale } from "../i18n/locale";

class FakeStatusEmitter implements StatusEmitter {
	public calls: Array<{ callerId: string; message: string }> = [];
	public shouldThrow = false;
	async emit(callerId: string, message: string): Promise<void> {
		if (this.shouldThrow) {
			throw new Error("emitter error");
		}
		this.calls.push({ callerId, message });
	}
}

const createFakeEmitter = (): StatusEmitter => new FakeStatusEmitter();

function createTestWorkspace(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return {
		workspace: new SqliteStateBackend({ db, dialect, namespace }),
		db,
	};
}

describe("createExecutionToolset enableToolStatus flag", () => {
	test("creates toolset with enableToolStatus false", async () => {
		const { workspace, db } = createTestWorkspace("factory-enable-false");

		const emitter = createFakeEmitter();
		const tools = await createExecutionToolset({
			workspace,
			enableToolStatus: false,
			statusEmitter: emitter,
			locale: "en" as SupportedLocale,
		});

		expect(tools.length).toBeGreaterThan(0);
		await db.close();
	});

	test("creates toolset with enableToolStatus true", async () => {
		const { workspace, db } = createTestWorkspace("factory-enable-true");

		const emitter = createFakeEmitter();
		const tools = await createExecutionToolset({
			workspace,
			enableToolStatus: true,
			statusEmitter: emitter,
			locale: "en" as SupportedLocale,
		});

		expect(tools.length).toBeGreaterThan(0);
		await db.close();
	});

	test("creates toolset with default enableToolStatus (undefined = true)", async () => {
		const { workspace, db } = createTestWorkspace("factory-enable-default");

		const emitter = createFakeEmitter();
		const tools = await createExecutionToolset({
			workspace,
			statusEmitter: emitter,
			locale: "en" as SupportedLocale,
		});

		expect(tools.length).toBeGreaterThan(0);
		await db.close();
	});
});