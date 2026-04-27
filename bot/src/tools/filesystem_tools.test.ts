import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import {
	createEditFileTool,
	createGlobTool,
	createGrepTool,
	createLsTool,
	createReadFileTool,
	createWriteFileTool,
} from "./filesystem_tools";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

const ONE_BY_ONE_PNG = Uint8Array.from([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
	0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218,
	99, 252, 255, 31, 0, 3, 3, 2, 0, 239, 239, 170, 119, 0, 0, 0, 0, 73, 69, 78,
	68, 174, 66, 96, 130,
]);

describe("createLsTool", () => {
	test("lists files and directories", async () => {
		const backend = createBackend("ls-list");
		await backend.write("/root.txt", "hello");
		await backend.write("/nested/child.txt", "world");
		const tool = createLsTool(backend);

		const result = await tool.invoke({ path: "/" });

		expect(result).toBe("/nested/ (directory)\n/root.txt (5 bytes)");
	});

	test("returns empty-directory message", async () => {
		const backend = createBackend("ls-empty");
		const tool = createLsTool(backend);

		const result = await tool.invoke({ path: "/" });

		expect(result).toBe("No files found in /");
	});
});

describe("createReadFileTool", () => {
	test("formats file data with line numbers", async () => {
		const backend = createBackend("read-format");
		await backend.write("/notes.txt", "alpha\nbeta");
		const tool = createReadFileTool(backend);

		const result = await tool.invoke({ file_path: "/notes.txt" });

		expect(result).toBe("     1\talpha\n     2\tbeta");
	});

	test("supports pagination", async () => {
		const backend = createBackend("read-page");
		await backend.write("/notes.txt", "alpha\nbeta\ngamma");
		const tool = createReadFileTool(backend);

		const result = await tool.invoke({
			file_path: "/notes.txt",
			offset: 1,
			limit: 1,
		});

		expect(result).toBe("     2\tbeta");
	});

	test("returns empty-file warning", async () => {
		const backend = createBackend("read-empty");
		await backend.write("/empty.txt", "");
		const tool = createReadFileTool(backend);

		const result = await tool.invoke({ file_path: "/empty.txt" });

		expect(result).toBe("System reminder: File exists but has empty contents");
	});

	test("returns offset error when beyond file length", async () => {
		const backend = createBackend("read-offset");
		await backend.write("/notes.txt", "alpha");
		const tool = createReadFileTool(backend);

		const result = await tool.invoke({ file_path: "/notes.txt", offset: 5 });

		expect(result).toBe("Error: Line offset 5 exceeds file length (1 lines)");
	});

	test("returns missing-file error", async () => {
		const backend = createBackend("read-missing");
		const tool = createReadFileTool(backend);

		const result = await tool.invoke({ file_path: "/missing.txt" });

		expect(result).toBe("Error: File '/missing.txt' not found");
	});

	test("returns multimodal content blocks for images", async () => {
		const backend = createBackend("read-image");
		await backend.uploadFiles([["/pixel.png", ONE_BY_ONE_PNG]]);
		const tool = createReadFileTool(backend);

		const result = await tool.invoke({ file_path: "/pixel.png" });

		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([
			{
				type: "text",
				text: "Attached file '/pixel.png' (image/png) for multimodal inspection.",
			},
			{
				type: "image",
				mimeType: "image/png",
				data: ONE_BY_ONE_PNG,
			},
		]);
	});
});

describe("createWriteFileTool", () => {
	test("writes a new file and returns upstream success message", async () => {
		const backend = createBackend("write-ok");
		const tool = createWriteFileTool(backend);

		const result = await tool.invoke({ file_path: "/notes.txt", content: "" });

		expect(result).toBe("Successfully wrote to '/notes.txt'");
		expect(await backend.read("/notes.txt", 0, 10)).toBe(
			"System reminder: File exists but has empty contents",
		);
	});

	test("returns backend error when writing an existing file", async () => {
		const backend = createBackend("write-existing");
		await backend.write("/notes.txt", "alpha");
		const tool = createWriteFileTool(backend);

		const result = await tool.invoke({
			file_path: "/notes.txt",
			content: "beta",
		});

		expect(result).toBe(
			"Cannot write to /notes.txt because it already exists. Read and then make an edit, or write to a new path.",
		);
	});
});

describe("createEditFileTool", () => {
	test("edits a file and returns upstream success message", async () => {
		const backend = createBackend("edit-ok");
		await backend.write("/notes.txt", "alpha\nbeta");
		const tool = createEditFileTool(backend);

		const result = await tool.invoke({
			file_path: "/notes.txt",
			old_string: "beta",
			new_string: "gamma",
		});

		expect(result).toBe(
			"Successfully replaced 1 occurrence(s) in '/notes.txt'",
		);
		expect(await backend.read("/notes.txt", 0, 10)).toBe(
			"     1\talpha\n     2\tgamma",
		);
	});

	test("returns not-found error for missing old string", async () => {
		const backend = createBackend("edit-missing-string");
		await backend.write("/notes.txt", "alpha");
		const tool = createEditFileTool(backend);

		const result = await tool.invoke({
			file_path: "/notes.txt",
			old_string: "beta",
			new_string: "gamma",
		});

		expect(result).toBe("Error: String not found in file: 'beta'");
	});

	test("requires replace_all for multiple matches", async () => {
		const backend = createBackend("edit-multi");
		await backend.write("/notes.txt", "alpha\nalpha");
		const tool = createEditFileTool(backend);

		const result = await tool.invoke({
			file_path: "/notes.txt",
			old_string: "alpha",
			new_string: "beta",
		});

		expect(result).toBe(
			"Error: String 'alpha' has multiple occurrences (appears 2 times) in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.",
		);
	});

	test("supports replace_all", async () => {
		const backend = createBackend("edit-replace-all");
		await backend.write("/notes.txt", "alpha\nalpha");
		const tool = createEditFileTool(backend);

		const result = await tool.invoke({
			file_path: "/notes.txt",
			old_string: "alpha",
			new_string: "beta",
			replace_all: true,
		});

		expect(result).toBe(
			"Successfully replaced 2 occurrence(s) in '/notes.txt'",
		);
		expect(await backend.read("/notes.txt", 0, 10)).toBe(
			"     1\tbeta\n     2\tbeta",
		);
	});
});

describe("createGlobTool", () => {
	test("returns matching files", async () => {
		const backend = createBackend("glob-match");
		await backend.write("/a.ts", "a");
		await backend.write("/nested/b.ts", "b");
		await backend.write("/c.txt", "c");
		const tool = createGlobTool(backend);

		const result = await tool.invoke({ pattern: "**/*.ts", path: "/" });

		expect(result).toBe("/a.ts\n/nested/b.ts");
	});

	test("returns upstream empty-result message", async () => {
		const backend = createBackend("glob-empty");
		const tool = createGlobTool(backend);

		const result = await tool.invoke({ pattern: "**/*.ts", path: "/" });

		expect(result).toBe("No files found matching pattern '**/*.ts'");
	});
});

describe("createGrepTool", () => {
	test("groups regex matches by file", async () => {
		const backend = createBackend("grep-grouped");
		await backend.write("/a.ts", "const alpha = 1;\nconst beta = 2;");
		await backend.write("/b.ts", "const bravo = 3;");
		const tool = createGrepTool(backend);

		const result = await tool.invoke({
			pattern: "brav.|beta",
			path: "/",
			glob: "*.ts",
		});

		expect(result).toBe(
			"\n/a.ts:\n  2: const beta = 2;\n\n/b.ts:\n  1: const bravo = 3;",
		);
	});

	test("returns upstream empty-result message", async () => {
		const backend = createBackend("grep-empty");
		await backend.write("/a.ts", "const alpha = 1;");
		const tool = createGrepTool(backend);

		const result = await tool.invoke({
			pattern: "zeta",
			path: "/",
			glob: "*.ts",
		});

		expect(result).toBe("No matches found for pattern 'zeta'");
	});

	test("returns no matches for invalid regex", async () => {
		const backend = createBackend("grep-invalid");
		await backend.write("/a.ts", "const alpha = 1;");
		const tool = createGrepTool(backend);

		const result = await tool.invoke({ pattern: "(", path: "/", glob: "*.ts" });

		expect(result).toBe("No matches found for pattern '('");
	});
});
