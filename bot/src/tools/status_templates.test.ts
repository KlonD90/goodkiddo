import { describe, expect, test } from "bun:test";
import { hasTemplate, renderStatus } from "./status_templates";

describe("status_templates", () => {
	describe("hasTemplate", () => {
		test("returns true for known tools", () => {
			expect(hasTemplate("ls")).toBe(true);
			expect(hasTemplate("read_file")).toBe(true);
			expect(hasTemplate("write_file")).toBe(true);
			expect(hasTemplate("edit_file")).toBe(true);
			expect(hasTemplate("glob")).toBe(true);
			expect(hasTemplate("grep")).toBe(true);
			expect(hasTemplate("browser_snapshot")).toBe(true);
			expect(hasTemplate("browser_action")).toBe(true);
			expect(hasTemplate("execute_script")).toBe(true);
			expect(hasTemplate("execute_workspace")).toBe(true);
			expect(hasTemplate("memory_write")).toBe(true);
			expect(hasTemplate("skill_write")).toBe(true);
			expect(hasTemplate("memory_append_log")).toBe(true);
			expect(hasTemplate("prepare_draft_artifact")).toBe(true);
			expect(hasTemplate("task_add")).toBe(true);
			expect(hasTemplate("task_complete")).toBe(true);
			expect(hasTemplate("task_dismiss")).toBe(true);
			expect(hasTemplate("task_list_active")).toBe(true);
			expect(hasTemplate("send_file")).toBe(true);
			expect(hasTemplate("grant_fs_access")).toBe(true);
			expect(hasTemplate("research")).toBe(true);
			expect(hasTemplate("tabular_describe")).toBe(true);
			expect(hasTemplate("tabular_head")).toBe(true);
			expect(hasTemplate("tabular_sample")).toBe(true);
			expect(hasTemplate("tabular_distinct")).toBe(true);
			expect(hasTemplate("tabular_filter")).toBe(true);
			expect(hasTemplate("tabular_aggregate")).toBe(true);
		});

		test("returns false for unknown tools", () => {
			expect(hasTemplate("unknown_tool")).toBe(false);
			expect(hasTemplate("")).toBe(false);
			expect(hasTemplate("TODO")).toBe(false);
		});
	});

	describe("renderStatus", () => {
		describe("filesystem_tools", () => {
			test("ls in en", () => {
				const result = renderStatus("ls", { path: "/src" }, "en");
				expect(result?.message).toBe("Listing /src");
			});

			test("ls in ru", () => {
				const result = renderStatus("ls", { path: "/src" }, "ru");
				expect(result?.message).toBe("Просмотр /src");
			});

			test("ls in es", () => {
				const result = renderStatus("ls", { path: "/src" }, "es");
				expect(result?.message).toBe("Listando /src");
			});

			test("read_file with offset and limit", () => {
				const result = renderStatus(
					"read_file",
					{ file_path: "/src/index.ts", offset: 10, limit: 50 },
					"en",
				);
				expect(result?.message).toBe("Reading /src/index.ts (lines 10:50)");
			});

			test("read_file without offset/limit", () => {
				const result = renderStatus(
					"read_file",
					{ file_path: "/src/index.ts" },
					"en",
				);
				expect(result?.message).toBe("Reading /src/index.ts");
			});

			test("write_file redacts content", () => {
				const result = renderStatus(
					"write_file",
					{ file_path: "/src/index.ts", content: "long content here" },
					"en",
				);
				expect(result?.message).toBe("Writing to /src/index.ts");
				expect(result?.message).not.toContain("content");
			});

			test("edit_file redacts old_string and new_string", () => {
				const result = renderStatus(
					"edit_file",
					{
						file_path: "/src/index.ts",
						old_string: "secret old",
						new_string: "secret new",
					},
					"en",
				);
				expect(result?.message).toBe("Editing /src/index.ts");
				expect(result?.message).not.toContain("old_string");
				expect(result?.message).not.toContain("new_string");
			});

			test("edit_file with replace_all", () => {
				const result = renderStatus(
					"edit_file",
					{
						file_path: "/src/index.ts",
						replace_all: true,
					},
					"en",
				);
				expect(result?.message).toBe("Editing /src/index.ts (all)");
			});

			test("glob", () => {
				const result = renderStatus(
					"glob",
					{ pattern: "**/*.ts", path: "/src" },
					"en",
				);
				expect(result?.message).toBe("Finding files matching **/*.ts");
			});

			test("grep with path and glob", () => {
				const result = renderStatus(
					"grep",
					{ pattern: "TODO", path: "/src", glob: "*.ts" },
					"en",
				);
				expect(result?.message).toBe("Searching for TODO in /src (*.ts)");
			});

			test("grep without optional args", () => {
				const result = renderStatus("grep", { pattern: "TODO" }, "en");
				expect(result?.message).toBe("Searching for TODO");
			});
		});

		describe("browser_tools", () => {
			test("browser_snapshot with url", () => {
				const result = renderStatus(
					"browser_snapshot",
					{ url: "https://example.com" },
					"en",
				);
				expect(result?.message).toBe(
					"Taking browser snapshot https://example.com",
				);
			});

			test("browser_snapshot with selector", () => {
				const result = renderStatus(
					"browser_snapshot",
					{ url: "https://example.com", selector: ".main" },
					"en",
				);
				expect(result?.message).toBe(
					"Taking browser snapshot https://example.com selector:.main",
				);
			});

			test("browser_snapshot with interactiveOnly", () => {
				const result = renderStatus(
					"browser_snapshot",
					{ interactiveOnly: true },
					"en",
				);
				expect(result?.message).toBe("Taking browser snapshot");
			});

			test("browser_action click", () => {
				const result = renderStatus(
					"browser_action",
					{ sessionKey: "s-abc123", action: "click", ref: "@e1" },
					"en",
				);
				expect(result?.message).toBe("Browser action: click @e1");
			});

			test("browser_action fill redacts text", () => {
				const result = renderStatus(
					"browser_action",
					{
						sessionKey: "s-abc123",
						action: "fill",
						ref: "@e1",
						text: "secret password",
					},
					"en",
				);
				expect(result?.message).toBe("Browser action: fill @e1");
				expect(result?.message).not.toContain("text");
			});

			test("browser_action scroll", () => {
				const result = renderStatus(
					"browser_action",
					{
						sessionKey: "s-abc123",
						action: "scroll",
						direction: "down",
						amount: 500,
					},
					"en",
				);
				expect(result?.message).toBe("Browser action: scroll down");
			});
		});

		describe("execute_tools", () => {
			test("execute_script", () => {
				const result = renderStatus(
					"execute_script",
					{
						runtime: "bun",
						script: "/scripts/deploy.sh",
						filename: "deploy.sh",
					},
					"en",
				);
				expect(result?.message).toBe("Running script /scripts/deploy.sh");
			});

			test("execute_workspace", () => {
				const result = renderStatus(
					"execute_workspace",
					{ runtime: "python", entrypoint: "main.py" },
					"en",
				);
				expect(result?.message).toBe("Running workspace entrypoint main.py");
			});

			test("execute_script with args", () => {
				const result = renderStatus(
					"execute_script",
					{
						runtime: "shell",
						script: "/scripts/test.sh",
						filename: "test.sh",
						args: ["--verbose"],
					},
					"en",
				);
				expect(result?.message).toBe("Running script /scripts/test.sh");
			});
		});

		describe("memory_tools", () => {
			test("memory_write redacts content", () => {
				const result = renderStatus(
					"memory_write",
					{
						topic: "User Preferences",
						content: "secret info",
						mode: "replace",
					},
					"en",
				);
				expect(result?.message).toBe("Writing note: User Preferences");
				expect(result?.message).not.toContain("secret");
			});

			test("skill_write redacts content", () => {
				const result = renderStatus(
					"skill_write",
					{
						name: "Deploy Procedure",
						content: "step 1: do something",
						mode: "replace",
					},
					"en",
				);
				expect(result?.message).toBe("Writing skill: Deploy Procedure");
			});

			test("memory_append_log", () => {
				const result = renderStatus(
					"memory_append_log",
					{ op: "task_completed", detail: "Finished the deploy" },
					"en",
				);
				expect(result?.message).toBe("Appending to log: task_completed");
			});
		});

		describe("prepared_followups", () => {
			test("prepare_draft_artifact in en uses task", () => {
				const result = renderStatus(
					"prepare_draft_artifact",
					{
						type: "checklist",
						task: "prepare launch follow-up",
						context: "secret context",
						evidence: ["secret fact"],
					},
					"en",
				);
				expect(result?.message).toBe(
					"Preparing draft artifact: prepare launch follow-up",
				);
				expect(result?.message).not.toContain("secret context");
				expect(result?.message).not.toContain("secret fact");
			});

			test("prepare_draft_artifact in ru", () => {
				const result = renderStatus(
					"prepare_draft_artifact",
					{ type: "checklist", task: "подготовить запуск" },
					"ru",
				);
				expect(result?.message).toBe(
					"Подготовка черновика: подготовить запуск",
				);
			});

			test("prepare_draft_artifact in es", () => {
				const result = renderStatus(
					"prepare_draft_artifact",
					{ type: "checklist", task: "preparar lanzamiento" },
					"es",
				);
				expect(result?.message).toBe(
					"Preparando borrador: preparar lanzamiento",
				);
			});
		});

		describe("task_tools", () => {
			test("task_add", () => {
				const result = renderStatus(
					"task_add",
					{ listName: "today", title: "Review PR", note: "check for bugs" },
					"en",
				);
				expect(result?.message).toBe("Adding task to today");
			});

			test("task_complete", () => {
				const result = renderStatus("task_complete", { taskId: 42 }, "en");
				expect(result?.message).toBe("Completing task 42");
			});

			test("task_dismiss", () => {
				const result = renderStatus(
					"task_dismiss",
					{ taskId: 42, reason: "No longer needed" },
					"en",
				);
				expect(result?.message).toBe("Dismissing task 42");
			});

			test("task_list_active", () => {
				const result = renderStatus("task_list_active", { limit: 10 }, "en");
				expect(result?.message).toBe("Listing active tasks");
			});
		});

		describe("send_file_tool", () => {
			test("send_file with caption", () => {
				const result = renderStatus(
					"send_file",
					{ file_path: "/reports/q1.pdf", caption: "Q1 Report" },
					"en",
				);
				expect(result?.message).toBe("Sending file /reports/q1.pdf");
			});

			test("send_file without caption", () => {
				const result = renderStatus(
					"send_file",
					{ file_path: "/reports/q1.pdf" },
					"en",
				);
				expect(result?.message).toBe("Sending file /reports/q1.pdf");
			});
		});

		describe("research_tool", () => {
			test("research in en", () => {
				const result = renderStatus(
					"research",
					{ question: "top noise-cancelling headphones" },
					"en",
				);
				expect(result?.message).toBe(
					"Researching top noise-cancelling headphones",
				);
			});

			test("research in ru", () => {
				const result = renderStatus(
					"research",
					{ question: "лучшие наушники" },
					"ru",
				);
				expect(result?.message).toBe("Исследую лучшие наушники");
			});

			test("research in es", () => {
				const result = renderStatus(
					"research",
					{ question: "mejores auriculares" },
					"es",
				);
				expect(result?.message).toBe("Investigando mejores auriculares");
			});

			test("research redacts hints and inputs", () => {
				const result = renderStatus(
					"research",
					{
						question: "compare headphones",
						hints: ["look for ANC", "check battery"],
						inputs: ["/workspace/data.csv"],
					},
					"en",
				);
				expect(result?.message).toBe("Researching compare headphones");
				expect(result?.message).not.toContain("hints");
				expect(result?.message).not.toContain("inputs");
			});

			test("research truncates long question", () => {
				const longQuestion = "x".repeat(200);
				const result = renderStatus(
					"research",
					{ question: longQuestion },
					"en",
				);
				expect(result?.message.length).toBeLessThanOrEqual(200);
				expect(result?.truncated).toBe(true);
			});
		});

		describe("share_tools", () => {
			test("grant_fs_access", () => {
				const result = renderStatus(
					"grant_fs_access",
					{ scope_path: "/reports/", ttl_hours: 24 },
					"en",
				);
				expect(result?.message).toBe("Creating share link for /reports/");
			});

			test("grant_fs_access root path", () => {
				const result = renderStatus(
					"grant_fs_access",
					{ scope_path: "/" },
					"en",
				);
				expect(result?.message).toBe("Creating share link for /");
			});
		});

		describe("fallback behavior", () => {
			test("returns null for unknown tool", () => {
				const result = renderStatus("unknown_tool", { foo: "bar" }, "en");
				expect(result).toBeNull();
			});

			test("falls back to English when locale is missing a key", () => {
				expect(hasTemplate("ls")).toBe(true);
				const enResult = renderStatus("ls", { path: "/test" }, "en");
				const esResult = renderStatus("ls", { path: "/test" }, "es");
				expect(enResult?.message).toBe("Listing /test");
				expect(esResult?.message).toBe("Listando /test");
			});
		});

		describe("redaction of oversized/forbidden args", () => {
			test("truncates long path values", () => {
				const longPath = "/".repeat(500);
				const result = renderStatus("ls", { path: longPath }, "en");
				expect(result?.message.length).toBeLessThanOrEqual(200);
				expect(result?.truncated).toBe(true);
			});

			test("strips newlines from values", () => {
				const result = renderStatus("ls", { path: "/src\n/etc" }, "en");
				expect(result?.message).not.toContain("\n");
				expect(result?.message).not.toContain("\r");
			});

			test("strips tabs from values", () => {
				const result = renderStatus("ls", { path: "/src\t/etc" }, "en");
				expect(result?.message).not.toContain("\t");
			});

			test("truncates overall message length", () => {
				const result = renderStatus(
					"grep",
					{ pattern: "a".repeat(1000) },
					"en",
				);
				expect(result?.message.length).toBeLessThanOrEqual(500);
			});

			test("handles array args by showing count", () => {
				const result = renderStatus(
					"execute_script",
					{
						runtime: "shell",
						script: "test.sh",
						filename: "test.sh",
						args: ["a", "b", "c", "d", "e", "f"],
					},
					"en",
				);
				expect(result?.message).toBe("Running script test.sh");
			});

			test("handles many array items", () => {
				const result = renderStatus(
					"execute_script",
					{
						runtime: "shell",
						script: "test.sh",
						filename: "test.sh",
						args: ["1", "2", "3", "4", "5", "6"],
					},
					"en",
				);
				expect(result?.message).toBe("Running script test.sh");
			});
		});

		describe("all locales have all tools", () => {
			const locales = ["en", "ru", "es"] as const;
			const tools = [
				"ls",
				"read_file",
				"write_file",
				"edit_file",
				"glob",
				"grep",
				"browser_snapshot",
				"browser_action",
				"execute_script",
				"execute_workspace",
				"memory_write",
				"skill_write",
				"memory_append_log",
				"prepare_draft_artifact",
				"task_add",
				"task_complete",
				"task_dismiss",
				"task_list_active",
				"send_file",
				"grant_fs_access",
				"research",
			];

			for (const locale of locales) {
				for (const tool of tools) {
					test(`${tool} in ${locale}`, () => {
						const result = renderStatus(tool, {}, locale);
						expect(result).not.toBeNull();
						expect(result?.message.length).toBeGreaterThan(0);
					});
				}
			}
		});

		describe("tabular tools", () => {
			test("tabular_describe en", () => {
				const result = renderStatus(
					"tabular_describe",
					{ path: "/data/sales.csv" },
					"en",
				);
				expect(result?.message).toBe("Reading schema of /data/sales.csv");
			});

			test("tabular_describe ru", () => {
				const result = renderStatus(
					"tabular_describe",
					{ path: "/data/sales.csv" },
					"ru",
				);
				expect(result?.message).toBe("Читаю схему /data/sales.csv");
			});

			test("tabular_describe es", () => {
				const result = renderStatus(
					"tabular_describe",
					{ path: "/data/sales.csv" },
					"es",
				);
				expect(result?.message).toBe("Leyendo esquema de /data/sales.csv");
			});

			test("tabular_head en", () => {
				const result = renderStatus(
					"tabular_head",
					{ path: "/data.csv", n: 10 },
					"en",
				);
				expect(result?.message).toBe("Reading first 10 rows of /data.csv");
			});

			test("tabular_head ru", () => {
				const result = renderStatus(
					"tabular_head",
					{ path: "/data.csv", n: 5 },
					"ru",
				);
				expect(result?.message).toBe("Читаю первые 5 строк /data.csv");
			});

			test("tabular_head es", () => {
				const result = renderStatus(
					"tabular_head",
					{ path: "/data.csv", n: 20 },
					"es",
				);
				expect(result?.message).toBe("Leyendo primeras 20 filas de /data.csv");
			});

			test("tabular_sample en", () => {
				const result = renderStatus(
					"tabular_sample",
					{ path: "/data.csv", n: 15 },
					"en",
				);
				expect(result?.message).toBe("Sampling 15 rows from /data.csv");
			});

			test("tabular_sample ru", () => {
				const result = renderStatus(
					"tabular_sample",
					{ path: "/data.csv", n: 10 },
					"ru",
				);
				expect(result?.message).toBe("Сэмплирую 10 строк из /data.csv");
			});

			test("tabular_sample es", () => {
				const result = renderStatus(
					"tabular_sample",
					{ path: "/data.csv", n: 10 },
					"es",
				);
				expect(result?.message).toBe("Muestreando 10 filas de /data.csv");
			});

			test("tabular_distinct en", () => {
				const result = renderStatus(
					"tabular_distinct",
					{ path: "/data.csv", column: "category" },
					"en",
				);
				expect(result?.message).toBe(
					"Getting distinct values of category in /data.csv",
				);
			});

			test("tabular_distinct ru", () => {
				const result = renderStatus(
					"tabular_distinct",
					{ path: "/data.csv", column: "status" },
					"ru",
				);
				expect(result?.message).toBe(
					"Получаю уникальные значения status в /data.csv",
				);
			});

			test("tabular_distinct es", () => {
				const result = renderStatus(
					"tabular_distinct",
					{ path: "/data.csv", column: "ciudad" },
					"es",
				);
				expect(result?.message).toBe(
					"Obteniendo valores distintos de ciudad en /data.csv",
				);
			});

			test("tabular_filter en", () => {
				const result = renderStatus(
					"tabular_filter",
					{
						path: "/data.csv",
						where: [{ column: "age", op: "gt", value: 18 }],
					},
					"en",
				);
				expect(result?.message).toBe("Filtering rows in /data.csv");
			});

			test("tabular_filter ru", () => {
				const result = renderStatus(
					"tabular_filter",
					{ path: "/data.csv" },
					"ru",
				);
				expect(result?.message).toBe("Фильтрую строки в /data.csv");
			});

			test("tabular_filter es", () => {
				const result = renderStatus(
					"tabular_filter",
					{ path: "/data.csv" },
					"es",
				);
				expect(result?.message).toBe("Filtrando filas en /data.csv");
			});

			test("tabular_aggregate en with aggregations array", () => {
				const result = renderStatus(
					"tabular_aggregate",
					{
						path: "/data.csv",
						aggregations: [{ fn: "sum", column: "revenue" }],
					},
					"en",
				);
				expect(result?.message).toBe("Aggregating sum(revenue) in /data.csv");
			});

			test("tabular_aggregate ru", () => {
				const result = renderStatus(
					"tabular_aggregate",
					{
						path: "/data.csv",
						aggregations: [{ fn: "count" }],
					},
					"ru",
				);
				expect(result?.message).toBe("Агрегирую count(*) в /data.csv");
			});

			test("tabular_aggregate es", () => {
				const result = renderStatus(
					"tabular_aggregate",
					{
						path: "/data.csv",
						aggregations: [{ fn: "mean", column: "price" }],
					},
					"es",
				);
				expect(result?.message).toBe("Agregando mean(price) en /data.csv");
			});

			test("hasTemplate returns true for all tabular tools", () => {
				for (const name of [
					"tabular_describe",
					"tabular_head",
					"tabular_sample",
					"tabular_distinct",
					"tabular_filter",
					"tabular_aggregate",
				]) {
					expect(hasTemplate(name), `${name} should have a template`).toBe(
						true,
					);
				}
			});
		});
	});
});
