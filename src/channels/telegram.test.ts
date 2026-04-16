import { afterEach, describe, expect, test } from "bun:test";
import { PermissionsStore } from "../permissions/store";
import type { ApprovalOutcome } from "../permissions/approval";
import {
	chunkTelegramMessage,
	getTelegramCaller,
	maybeHandleTelegramApprovalReply,
} from "./telegram";

let store: PermissionsStore;

afterEach(() => {
	store?.close();
});

describe("telegram channel", () => {
	test("chunkTelegramMessage splits oversized payloads", () => {
		const longText = "a".repeat(5000);
		const chunks = chunkTelegramMessage(longText);

		expect(chunks).toHaveLength(2);
		expect(chunks[0]?.length).toBe(4096);
		expect(chunks.join("")).toBe(longText);
	});

	test("getTelegramCaller returns null for unknown or suspended users", () => {
		store = new PermissionsStore({ dbPath: ":memory:" });
		expect(getTelegramCaller(store, "123")).toBeNull();

		const user = store.upsertUser({
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Chat 123",
		});
		store.setUserStatus(user.id, "suspended");

		expect(getTelegramCaller(store, "123")).toBeNull();
	});

	test("getTelegramCaller returns an active telegram caller", () => {
		store = new PermissionsStore({ dbPath: ":memory:" });
		store.upsertUser({
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Chat 123",
		});

		expect(getTelegramCaller(store, "123")).toEqual({
			id: "telegram:123",
			entrypoint: "telegram",
			externalId: "123",
			displayName: "Chat 123",
		});
	});

	test("maybeHandleTelegramApprovalReply resolves known approval responses", async () => {
		const outcomes: ApprovalOutcome[] = [];
		const session = {
			agent: {} as never,
			running: false,
			queue: [],
			threadId: "telegram-123",
			pending: {
				request: {
					caller: {
						id: "telegram:123",
						entrypoint: "telegram" as const,
						externalId: "123",
					},
					toolName: "read_file",
					args: {},
				},
				resolve: async (outcome: ApprovalOutcome) => {
					outcomes.push(outcome);
				},
				timeout: setTimeout(() => undefined, 1000),
				promptId: "prompt-1",
			},
		};

		expect(maybeHandleTelegramApprovalReply(session, "always")).toBe(true);
		await Promise.resolve();
		clearTimeout(session.pending?.timeout);

		expect(outcomes).toEqual(["approve-always"]);
		expect(session.pending).toBeNull();
	});

	test("maybeHandleTelegramApprovalReply ignores unrelated text", () => {
		const session = {
			agent: {} as never,
			running: false,
			queue: [],
			threadId: "telegram-123",
			pending: null,
		};

		expect(maybeHandleTelegramApprovalReply(session, "hello")).toBe(false);
	});
});
