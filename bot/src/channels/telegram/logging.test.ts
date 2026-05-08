import { describe, expect, test } from "bun:test";
import {
	errorFieldsForLog,
	summarizeTelegramUpdateForLog,
} from "./logging";

describe("telegram logging helpers", () => {
	test("errorFieldsForLog includes Error stack and SQL-style metadata", () => {
		const error = Object.assign(new Error("integer out of range"), {
			code: "22003",
			table: "harness_users",
			column: "created_at",
			detail: "value exceeds integer range",
		});

		expect(errorFieldsForLog(error)).toMatchObject({
			error: "integer out of range",
			errorName: "Error",
			errorCode: "22003",
			errorTable: "harness_users",
			errorColumn: "created_at",
			errorDetail: "value exceeds integer range",
		});
		expect(errorFieldsForLog(error).errorStack).toContain(
			"integer out of range",
		);
	});

	test("summarizeTelegramUpdateForLog captures text message metadata without content", () => {
		const summary = summarizeTelegramUpdateForLog({
			update_id: 135030354,
			message: {
				message_id: 77,
				date: 1778222935,
				text: "private message content",
				chat: { id: 123456, type: "private" },
				from: { id: 999 },
			},
		});

		expect(summary).toEqual({
			updateId: 135030354,
			updateType: "message",
			chatId: "123456",
			chatType: "private",
			fromId: "999",
			messageId: 77,
			messageDate: 1778222935,
			textLength: 23,
			messageKind: "text",
		});
		expect(Object.values(summary)).not.toContain("private message content");
	});

	test("summarizeTelegramUpdateForLog captures callback metadata with truncated data", () => {
		const summary = summarizeTelegramUpdateForLog({
			update_id: 42,
			callback_query: {
				id: "callback-1",
				data: "approve-once:prompt-id-with-long-suffix",
				from: { id: 555 },
				message: {
					message_id: 12,
					date: 1778222935,
					chat: { id: -100123, type: "supergroup" },
				},
			},
		});

		expect(summary).toMatchObject({
			updateId: 42,
			updateType: "callback_query",
			callbackQueryId: "callback-1",
			callbackDataLength: 39,
			callbackDataPrefix: "approve-once:prompt-id-with-long",
			fromId: "555",
			chatId: "-100123",
			chatType: "supergroup",
			messageId: 12,
			messageDate: 1778222935,
		});
	});
});
