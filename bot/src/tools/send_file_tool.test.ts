import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import type {
	OutboundChannel,
	OutboundSendFileArgs,
	OutboundSendResult,
} from "../channels/outbound";
import { createDb, detectDialect } from "../db";
import { createSendFileTool, SEND_FILE_MAX_BYTES } from "./send_file_tool";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

class RecordingOutbound implements OutboundChannel {
	calls: OutboundSendFileArgs[] = [];
	result: OutboundSendResult = { ok: true };

	async sendFile(args: OutboundSendFileArgs): Promise<OutboundSendResult> {
		this.calls.push(args);
		return this.result;
	}

	async sendStatus(_callerId: string, _message: string): Promise<void> {}
}

const CALLER_ID = "telegram:12345";

describe("createSendFileTool", () => {
	test("sends a text file with detected mime type", async () => {
		const backend = createBackend("send-text");
		await backend.write("/notes.md", "# hello");
		const outbound = new RecordingOutbound();
		const tool = createSendFileTool({
			workspace: backend,
			outbound,
			callerId: CALLER_ID,
		});

		const result = await tool.invoke({ file_path: "/notes.md" });

		expect(outbound.calls).toHaveLength(1);
		const call = outbound.calls[0];
		expect(call.callerId).toBe(CALLER_ID);
		expect(call.path).toBe("/notes.md");
		expect(call.mimeType).toBe("text/markdown");
		expect(new TextDecoder().decode(call.bytes)).toBe("# hello");
		expect(result).toBe(
			"Sent 'notes.md' (7 bytes, text/markdown) to the user.",
		);
	});

	test("sends binary content round-trip", async () => {
		const backend = createBackend("send-bin");
		const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
		await backend.uploadFiles([["/blob.bin", bytes]]);
		const outbound = new RecordingOutbound();
		const tool = createSendFileTool({
			workspace: backend,
			outbound,
			callerId: CALLER_ID,
		});

		await tool.invoke({ file_path: "/blob.bin" });

		expect(outbound.calls[0].bytes).toEqual(bytes);
		expect(outbound.calls[0].mimeType).toBe("application/octet-stream");
	});

	test("normalizes path without leading slash", async () => {
		const backend = createBackend("send-slash");
		await backend.write("/notes.txt", "ok");
		const outbound = new RecordingOutbound();
		const tool = createSendFileTool({
			workspace: backend,
			outbound,
			callerId: CALLER_ID,
		});

		await tool.invoke({ file_path: "notes.txt" });

		expect(outbound.calls[0].path).toBe("/notes.txt");
	});

	test("returns error for missing file and does not call outbound", async () => {
		const backend = createBackend("send-missing");
		const outbound = new RecordingOutbound();
		const tool = createSendFileTool({
			workspace: backend,
			outbound,
			callerId: CALLER_ID,
		});

		const result = await tool.invoke({ file_path: "/missing.txt" });

		expect(result).toBe("Error: file '/missing.txt' not found.");
		expect(outbound.calls).toHaveLength(0);
	});

	test("rejects internal prepared follow-up drafts", async () => {
		const backend = createBackend("send-internal-draft");
		await backend.write("/prepared-followups/d-123.md", "# draft");
		const outbound = new RecordingOutbound();
		const tool = createSendFileTool({
			workspace: backend,
			outbound,
			callerId: CALLER_ID,
		});

		const result = await tool.invoke({
			file_path: "/prepared-followups/d-123.md",
		});

		expect(result).toContain("internal prepared follow-up draft");
		expect(outbound.calls).toHaveLength(0);
	});

	test("rejects normalized paths into internal prepared follow-up drafts", async () => {
		const backend = createBackend("send-internal-draft-normalized");
		await backend.write("/prepared-followups/d-123.md", "# draft");
		const outbound = new RecordingOutbound();
		const tool = createSendFileTool({
			workspace: backend,
			outbound,
			callerId: CALLER_ID,
		});

		const result = await tool.invoke({
			file_path: "/x/../prepared-followups/d-123.md",
		});

		expect(result).toContain("internal prepared follow-up draft");
		expect(outbound.calls).toHaveLength(0);
	});

	test("rejects files over 20MB", async () => {
		const backend = createBackend("send-oversized");
		const oversized = new Uint8Array(SEND_FILE_MAX_BYTES + 1);
		await backend.uploadFiles([["/big.bin", oversized]]);
		const outbound = new RecordingOutbound();
		const tool = createSendFileTool({
			workspace: backend,
			outbound,
			callerId: CALLER_ID,
		});

		const result = await tool.invoke({ file_path: "/big.bin" });

		expect(result).toContain("exceeds the");
		expect(result).toContain("send limit");
		expect(outbound.calls).toHaveLength(0);
	});

	test("surfaces outbound failures to the model", async () => {
		const backend = createBackend("send-fail");
		await backend.write("/notes.txt", "hi");
		const outbound = new RecordingOutbound();
		outbound.result = { ok: false, error: "telegram offline" };
		const tool = createSendFileTool({
			workspace: backend,
			outbound,
			callerId: CALLER_ID,
		});

		const result = await tool.invoke({ file_path: "/notes.txt" });

		expect(result).toBe("Error: delivery failed — telegram offline");
	});

	test("passes caption through", async () => {
		const backend = createBackend("send-caption");
		await backend.write("/notes.txt", "hi");
		const outbound = new RecordingOutbound();
		const tool = createSendFileTool({
			workspace: backend,
			outbound,
			callerId: CALLER_ID,
		});

		await tool.invoke({ file_path: "/notes.txt", caption: "here you go" });

		expect(outbound.calls[0].caption).toBe("here you go");
	});
});
