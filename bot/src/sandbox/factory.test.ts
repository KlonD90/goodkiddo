import { describe, expect, test } from "bun:test";
import { createSandboxBackend } from "./factory";

describe("createSandboxBackend", () => {
	test("returns docker backend explicitly", async () => {
		const backend = await createSandboxBackend({ backend: "docker" });
		expect(backend.capabilities().isolation).toBe("dev");
		expect(backend.capabilities().supportsRealMicrovm).toBe(false);
	});
});
