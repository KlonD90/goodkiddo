import { describe, expect, test } from "bun:test";
import {
	normalizeRelativePath,
	prepareExecuteScript,
	prepareExecuteWorkspace,
} from "./manifest";

describe("manifest preparation", () => {
	test("rejects absolute paths", () => {
		expect(() => normalizeRelativePath("/tmp/test.py")).toThrow();
	});

	test("rejects path traversal", () => {
		expect(() => normalizeRelativePath("../secrets.py")).toThrow();
	});

	test("prepares execute_script with derived network mode", () => {
		const prepared = prepareExecuteScript({
			runtime: "python",
			script: "print('hi')",
			filename: "main.py",
			networkDomains: [],
			dataRequirements: [],
			expectedOutputs: [],
			args: [],
			supportFiles: [],
		});

		expect(prepared.manifest.entrypoint).toBe("main.py");
		expect(prepared.manifest.sessionMode).toBe("isolated-data");
		expect(prepared.manifest.requiresNetwork).toBe(false);
	});

	test("rejects mixed data and network access", () => {
		expect(() =>
			prepareExecuteScript({
				runtime: "python",
				script: "print('hi')",
				filename: "main.py",
				networkDomains: ["example.com"],
				dataRequirements: [
					{ category: "user.identity", fields: ["email"], reason: "fill form" },
				],
				expectedOutputs: [],
				args: [],
				supportFiles: [],
			}),
		).toThrow(/cannot combine sensitive data access/i);
	});

	test("rejects agent-browser without domains", () => {
		expect(() =>
			prepareExecuteScript({
				runtime: "agent-browser",
				script: "agent-browser open https://example.com",
				filename: "browse.sh",
				networkDomains: [],
				dataRequirements: [],
				expectedOutputs: [],
				args: [],
				supportFiles: [],
			}),
		).toThrow(/requires at least one network domain/i);
	});

	test("prepares workspace execution from existing files", () => {
		const prepared = prepareExecuteWorkspace(
			{
				runtime: "bun",
				entrypoint: "src/main.ts",
				args: [],
				expectedOutputs: [],
				dataRequirements: [],
				networkDomains: [],
			},
			[
				{ path: "src/main.ts", content: "console.log('ok');" },
				{ path: "src/lib.ts", content: "export const value = 1;" },
			],
		);

		expect(prepared.manifest.entrypoint).toBe("src/main.ts");
		expect(prepared.files).toHaveLength(2);
	});
});
