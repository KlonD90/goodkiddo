import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RecentChatStore } from "./recent_chat_store";

type IndexListRow = {
	seq: number;
	name: string;
	unique: 0 | 1;
	origin: string;
	partial: 0 | 1;
};

type TableInfoRow = {
	cid: number;
	name: string;
	type: string;
	notnull: 0 | 1;
	dflt_value: string | null;
	pk: 0 | 1;
};

let db: InstanceType<typeof Bun.SQL>;
let store: RecentChatStore;
let currentTime: number;

beforeEach(() => {
	currentTime = 1_000;
	db = new Bun.SQL("sqlite://:memory:");
	store = new RecentChatStore({
		db,
		dialect: "sqlite",
		now: () => currentTime++,
	});
});

afterEach(async () => {
	await db.close();
});

describe("RecentChatStore", () => {
	test("creates the expected schema and indexes", async () => {
		await store.ready();

		const columns =
			await db<TableInfoRow[]>`PRAGMA table_info(fetch_recent_chat_messages)`;
		expect(columns.map((column) => column.name)).toEqual([
			"id",
			"caller_id",
			"chat_id",
			"message_id",
			"sender_label",
			"text",
			"kind",
			"message_timestamp",
			"created_at",
		]);

		const indexes =
			await db<IndexListRow[]>`PRAGMA index_list(fetch_recent_chat_messages)`;
		const indexNames = indexes.map((index) => index.name);
		expect(indexNames).toContain(
			"idx_fetch_recent_chat_messages_caller_created_at",
		);
	});

	test("records messages and lists recent caller messages oldest first", async () => {
		const first = await store.recordMessage({
			callerId: "telegram:chat:1",
			chatId: "telegram-chat-1",
			messageId: "10",
			senderLabel: "alice",
			text: "first message",
			kind: "group_text",
			messageTimestamp: 900,
		});
		const second = await store.recordMessage({
			callerId: "telegram:chat:1",
			chatId: "telegram-chat-1",
			messageId: "11",
			senderLabel: "bob",
			text: "second message",
			kind: "group_text",
			messageTimestamp: 901,
		});
		await store.recordMessage({
			callerId: "telegram:chat:2",
			chatId: "telegram-chat-2",
			messageId: "12",
			senderLabel: "carol",
			text: "other caller message",
			kind: "group_text",
			messageTimestamp: 902,
		});

		expect(first.id).toBeGreaterThan(0);
		expect(first.createdAt).toBe(1_000);
		expect(second.createdAt).toBe(1_001);

		const messages = await store.listRecentMessages("telegram:chat:1", {
			limit: 10,
		});
		expect(messages.map((message) => message.text)).toEqual([
			"first message",
			"second message",
		]);
		expect(messages[0]).toMatchObject({
			callerId: "telegram:chat:1",
			chatId: "telegram-chat-1",
			messageId: "10",
			senderLabel: "alice",
			kind: "group_text",
			messageTimestamp: 900,
			createdAt: 1_000,
		});
	});

	test("limits to the newest records while returning prompt order", async () => {
		await store.recordMessage({
			callerId: "telegram:chat:1",
			chatId: "telegram-chat-1",
			messageId: "10",
			senderLabel: "alice",
			text: "oldest",
			kind: "group_text",
		});
		await store.recordMessage({
			callerId: "telegram:chat:1",
			chatId: "telegram-chat-1",
			messageId: "11",
			senderLabel: "bob",
			text: "middle",
			kind: "group_text",
		});
		await store.recordMessage({
			callerId: "telegram:chat:1",
			chatId: "telegram-chat-1",
			messageId: "12",
			senderLabel: "carol",
			text: "newest",
			kind: "group_text",
		});

		const messages = await store.listRecentMessages("telegram:chat:1", {
			limit: 2,
		});

		expect(messages.map((message) => message.text)).toEqual([
			"middle",
			"newest",
		]);
	});

	test("rejects empty text and normalizes optional fields", async () => {
		await expect(
			store.recordMessage({
				callerId: "telegram:chat:1",
				chatId: "telegram-chat-1",
				messageId: "10",
				senderLabel: "alice",
				text: "   ",
				kind: "group_text",
			}),
		).rejects.toThrow("Recent chat message text cannot be empty.");

		const message = await store.recordMessage({
			callerId: "telegram:chat:1",
			chatId: "telegram-chat-1",
			text: "  hello   there  ",
		});

		expect(message.messageId).toBeNull();
		expect(message.senderLabel).toBeNull();
		expect(message.text).toBe("hello there");
		expect(message.kind).toBe("text");
		expect(message.messageTimestamp).toBeNull();
	});

	test("prunes records older than the requested age for one caller", async () => {
		currentTime = 1_000;
		await store.recordMessage({
			callerId: "telegram:chat:1",
			chatId: "telegram-chat-1",
			text: "old",
		});
		currentTime = 2_000;
		await store.recordMessage({
			callerId: "telegram:chat:1",
			chatId: "telegram-chat-1",
			text: "new",
		});
		currentTime = 1_000;
		await store.recordMessage({
			callerId: "telegram:chat:2",
			chatId: "telegram-chat-2",
			text: "other caller old",
		});

		currentTime = 3_000;
		const deleted = await store.pruneOldMessages("telegram:chat:1", 1_500);

		expect(deleted).toBe(1);
		expect(
			(await store.listRecentMessages("telegram:chat:1", { limit: 10 })).map(
				(message) => message.text,
			),
		).toEqual(["new"]);
		expect(
			(await store.listRecentMessages("telegram:chat:2", { limit: 10 })).map(
				(message) => message.text,
			),
		).toEqual(["other caller old"]);
	});
});
