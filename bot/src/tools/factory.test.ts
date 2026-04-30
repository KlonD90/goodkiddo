import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { SqliteStateBackend } from "../backends";
import type { ImageUnderstandingProvider } from "../capabilities/image/types";
import { StreamingTabularEngine } from "../capabilities/tabular/streaming_engine";
import { createDb, detectDialect } from "../db";
import type { SupportedLocale } from "../i18n/locale";
import { createExecutionToolset } from "./factory";
import type { StatusEmitter } from "./status_emitter";

function stubModel(): BaseChatModel {
	return {
		invoke: async () => ({ content: "" }),
	} as unknown as BaseChatModel;
}

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

type InvokableTool = {
	name: string;
	invoke: (input: unknown) => Promise<string>;
};

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

	test("omits understand_image tool when no image-understanding provider is supplied", async () => {
		const { workspace, db } = createTestWorkspace("factory-image-off");
		const tools = await createExecutionToolset({ workspace });
		expect(
			tools.find((tool) => tool.name === "understand_image"),
		).toBeUndefined();
		await db.close();
	});

	test("includes understand_image tool when an image-understanding provider is supplied", async () => {
		const { workspace, db } = createTestWorkspace("factory-image-on");
		const provider: ImageUnderstandingProvider = {
			async understand() {
				return { text: "stub" };
			},
			async close() {},
		};

		const tools = await createExecutionToolset({
			workspace,
			imageUnderstandingProvider: provider,
		});

		expect(
			tools.find((tool) => tool.name === "understand_image"),
		).toBeDefined();
		await db.close();
	});

	test("research tool is registered when model is provided", async () => {
		const { workspace, db } = createTestWorkspace("factory-research-on");
		const tools = await createExecutionToolset({
			workspace,
			model: stubModel(),
		});
		expect(tools.find((t) => t.name === "research")).toBeDefined();
		await db.close();
	});

	test("research tool is absent when no model is provided", async () => {
		const { workspace, db } = createTestWorkspace("factory-research-off");
		const tools = await createExecutionToolset({ workspace });
		expect(tools.find((t) => t.name === "research")).toBeUndefined();
		await db.close();
	});

	test("prepared draft artifact tool is registered", async () => {
		const { workspace, db } = createTestWorkspace("factory-prepared-drafts");
		const tools = await createExecutionToolset({ workspace });
		expect(tools.find((t) => t.name === "prepare_draft_artifact")).toBeDefined();
		await db.close();
	});

	test("browser_snapshot and browser_action absent when enableBrowserOnParent is false (default)", async () => {
		const { workspace, db } = createTestWorkspace("factory-browser-off");
		const tools = await createExecutionToolset({ workspace });
		expect(tools.find((t) => t.name === "browser_snapshot")).toBeUndefined();
		expect(tools.find((t) => t.name === "browser_action")).toBeUndefined();
		await db.close();
	});

	test("browser_snapshot and browser_action present when enableBrowserOnParent is true", async () => {
		const { workspace, db } = createTestWorkspace("factory-browser-on");
		const tools = await createExecutionToolset({
			workspace,
			enableBrowserOnParent: true,
		});
		expect(tools.find((t) => t.name === "browser_snapshot")).toBeDefined();
		expect(tools.find((t) => t.name === "browser_action")).toBeDefined();
		await db.close();
	});

	test("passes memory mutation callbacks into memory tools", async () => {
		const { workspace, db } = createTestWorkspace("factory-memory-callback");
		const mutations: string[] = [];
		const tools = await createExecutionToolset({
			workspace,
			onMemoryMutation: (kind) => {
				mutations.push(kind);
			},
		});
		const memoryWrite = tools.find((tool) => tool.name === "memory_write") as
			| InvokableTool
			| undefined;
		if (!memoryWrite) throw new Error("Expected memory_write tool");

		await memoryWrite.invoke({
			target: "user",
			content: "Timezone: Asia/Bangkok.",
		});

		expect(mutations).toEqual(["user"]);
		await db.close();
	});

	test("tabular tools absent when no engine provided", async () => {
		const { workspace, db } = createTestWorkspace("factory-tabular-off");
		const tools = await createExecutionToolset({ workspace });
		expect(tools.find((t) => t.name === "tabular_describe")).toBeUndefined();
		expect(tools.find((t) => t.name === "tabular_head")).toBeUndefined();
		await db.close();
	});

	test("tabular tools present when engine is provided", async () => {
		const { workspace, db } = createTestWorkspace("factory-tabular-on");
		const tools = await createExecutionToolset({
			workspace,
			tabularEngine: new StreamingTabularEngine(),
		});
		expect(tools.find((t) => t.name === "tabular_describe")).toBeDefined();
		expect(tools.find((t) => t.name === "tabular_head")).toBeDefined();
		expect(tools.find((t) => t.name === "tabular_sample")).toBeDefined();
		expect(tools.find((t) => t.name === "tabular_distinct")).toBeDefined();
		expect(tools.find((t) => t.name === "tabular_filter")).toBeDefined();
		expect(tools.find((t) => t.name === "tabular_aggregate")).toBeDefined();
		await db.close();
	});

	test("tabular tools absent when enableTabular is false even if engine is provided", async () => {
		const { workspace, db } = createTestWorkspace("factory-tabular-disabled");
		const tools = await createExecutionToolset({
			workspace,
			tabularEngine: new StreamingTabularEngine(),
			enableTabular: false,
		});
		expect(tools.find((t) => t.name === "tabular_describe")).toBeUndefined();
		await db.close();
	});
});
