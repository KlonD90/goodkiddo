import { describe, expect, test, vi } from "bun:test";
import { createContextAwareStatusEmitter } from "./session";
import type { ChannelAgentSession } from "../shared";
import type { StatusEmitter } from "../../tools/status_emitter";

describe("createContextAwareStatusEmitter", () => {
	const makeFixture = () => {
		const underlying: StatusEmitter = {
			emit: vi.fn(async () => {}),
		};
		const sessionRef: { current?: ChannelAgentSession } = {};
		const wrapped = createContextAwareStatusEmitter(underlying, sessionRef);
		return { underlying, sessionRef, wrapped };
	};

	test("forwards emit when current turn source is telegram_message", async () => {
		const { underlying, sessionRef, wrapped } = makeFixture();
		sessionRef.current = {
			currentTurnContext: {
				now: new Date(),
				source: "telegram_message",
			},
		} as unknown as ChannelAgentSession;

		await wrapped.emit("caller-1", "Reading file");

		expect(underlying.emit).toHaveBeenCalledTimes(1);
		expect(underlying.emit).toHaveBeenCalledWith("caller-1", "Reading file");
	});

	test("forwards emit when current turn source is cli", async () => {
		const { underlying, sessionRef, wrapped } = makeFixture();
		sessionRef.current = {
			currentTurnContext: {
				now: new Date(),
				source: "cli",
			},
		} as unknown as ChannelAgentSession;

		await wrapped.emit("caller-1", "Running script");

		expect(underlying.emit).toHaveBeenCalledTimes(1);
		expect(underlying.emit).toHaveBeenCalledWith("caller-1", "Running script");
	});

	test("forwards emit when there is no current turn context", async () => {
		const { underlying, wrapped } = makeFixture();

		await wrapped.emit("caller-1", "Searching");

		expect(underlying.emit).toHaveBeenCalledTimes(1);
		expect(underlying.emit).toHaveBeenCalledWith("caller-1", "Searching");
	});

	test("suppresses emit when current turn source is scheduler", async () => {
		const { underlying, sessionRef, wrapped } = makeFixture();
		sessionRef.current = {
			currentTurnContext: {
				now: new Date(),
				source: "scheduler",
			},
		} as unknown as ChannelAgentSession;

		await wrapped.emit("caller-1", "Processing timer");

		expect(underlying.emit).toHaveBeenCalledTimes(0);
	});

	test("toggles suppression when the session source changes mid-turn", async () => {
		const { underlying, sessionRef, wrapped } = makeFixture();

		// Start as a normal user turn.
		sessionRef.current = {
			currentTurnContext: {
				now: new Date(),
				source: "telegram_message",
			},
		} as unknown as ChannelAgentSession;
		await wrapped.emit("caller-1", "Reading file");
		expect(underlying.emit).toHaveBeenCalledTimes(1);

		// Switch to scheduler context (e.g. timer fires during the same session).
		sessionRef.current.currentTurnContext = {
			now: new Date(),
			source: "scheduler",
		};
		await wrapped.emit("caller-1", "Processing timer");
		expect(underlying.emit).toHaveBeenCalledTimes(1);

		// Back to user turn.
		sessionRef.current.currentTurnContext = {
			now: new Date(),
			source: "telegram_message",
		};
		await wrapped.emit("caller-1", "Done");
		expect(underlying.emit).toHaveBeenCalledTimes(2);
	});
});
