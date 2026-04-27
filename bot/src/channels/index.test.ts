import { describe, expect, test } from "bun:test";
import { channelRegistry, getAppChannel } from "./index";

describe("channel registry", () => {
	test("returns the CLI channel for cli entrypoint", () => {
		expect(getAppChannel("cli")).toBe(channelRegistry.cli);
	});

	test("returns the Telegram channel for telegram entrypoint", () => {
		expect(getAppChannel("telegram")).toBe(channelRegistry.telegram);
	});
});
