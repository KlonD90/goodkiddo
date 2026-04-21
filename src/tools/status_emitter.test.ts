import { describe, expect, test } from "bun:test";
import type { OutboundChannel, OutboundSendFileArgs } from "../channels/outbound";
import {
	createStatusEmitter,
	noopStatusEmitter,
	type StatusEmitter,
} from "./status_emitter";

class FakeOutboundChannel implements OutboundChannel {
	sendStatusCalls: Array<{ callerId: string; message: string }> = [];
	sendStatusError: Error | null = null;
	async sendFile(_args: OutboundSendFileArgs): Promise<{ ok: true }> {
		return { ok: true };
	}
	async sendStatus(callerId: string, message: string): Promise<void> {
		if (this.sendStatusError) {
			throw this.sendStatusError;
		}
		this.sendStatusCalls.push({ callerId, message });
	}
}

describe("StatusEmitter", () => {
	describe("noopStatusEmitter", () => {
		test("emit does nothing and never throws", async () => {
			await expect(
				noopStatusEmitter.emit("caller-1", "test message"),
			).resolves.toBeUndefined();
		});

		test("emit accepts any callerId and message", async () => {
			await expect(
				noopStatusEmitter.emit("", ""),
			).resolves.toBeUndefined();
			await expect(
				noopStatusEmitter.emit("cli:user", "Reading file.txt"),
			).resolves.toBeUndefined();
		});
	});

	describe("createStatusEmitter", () => {
		test("returns noop when outbound is undefined", async () => {
			const emitter = createStatusEmitter(undefined);
			expect(emitter).toBe(noopStatusEmitter);
			await emitter.emit("caller", "test");
		});

		test("returns functional emitter when outbound has sendStatus", async () => {
			const fakeChannel = new FakeOutboundChannel();
			const emitter = createStatusEmitter(fakeChannel);
			expect(emitter).not.toBe(noopStatusEmitter);

			await emitter.emit("caller-1", "Reading file.txt");

			expect(fakeChannel.sendStatusCalls).toHaveLength(1);
			expect(fakeChannel.sendStatusCalls[0]).toEqual({
				callerId: "caller-1",
				message: "Reading file.txt",
			});
		});

		test("swallows sendStatus errors internally", async () => {
			const fakeChannel = new FakeOutboundChannel();
			fakeChannel.sendStatusError = new Error("network error");
			const emitter = createStatusEmitter(fakeChannel);

			await expect(emitter.emit("caller-1", "test")).resolves.toBeUndefined();
		});

		test("multiple emit calls are all forwarded", async () => {
			const fakeChannel = new FakeOutboundChannel();
			const emitter = createStatusEmitter(fakeChannel);

			await emitter.emit("caller-1", "Reading a.txt");
			await emitter.emit("caller-1", "Reading b.txt");
			await emitter.emit("caller-2", "Searching for X");

			expect(fakeChannel.sendStatusCalls).toHaveLength(3);
			expect(fakeChannel.sendStatusCalls[0].message).toBe("Reading a.txt");
			expect(fakeChannel.sendStatusCalls[2].callerId).toBe("caller-2");
		});
	});
});
