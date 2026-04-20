import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends";
import { createDb, detectDialect } from "../db";
import { TaskStore } from "../tasks/store";
import { createExecutionToolset } from "./factory";
import {
	createTaskAddTool,
	createTaskCompleteTool,
	createTaskDismissTool,
	createTaskListActiveTool,
} from "./task_tools";

function createTaskContext(
	namespace: string,
	callerId = "telegram:1",
	currentUserText?: string,
) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return {
		db,
		dialect,
		store: new TaskStore({ db, dialect }),
		workspace: new SqliteStateBackend({ db, dialect, namespace }),
		callerId,
		threadId: "thread-active",
		currentUserText,
	};
}

describe("task tools", () => {
	test("task_add creates caller-scoped active tasks", async () => {
		const ctx = createTaskContext("task-add");
		const tool = createTaskAddTool(ctx);

		const result = await tool.invoke({
			listName: "today",
			title: "Ship task tools",
			note: "Before lunch",
		});

		expect(result).toContain("Added active task");
		const tasks = await ctx.store.listActiveTasks(ctx.callerId);
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({
			listName: "today",
			title: "Ship task tools",
			note: "Before lunch",
			threadIdCreated: "thread-active",
		});
		await ctx.db.close();
	});

	test("task_add rejects whitespace-only required fields", async () => {
		const ctx = createTaskContext("task-add-invalid");
		const tool = createTaskAddTool(ctx);

		await expect(
			tool.invoke({
				listName: "   ",
				title: "Ship task tools",
			}),
		).rejects.toThrow();
		await ctx.db.close();
	});

	test("task_complete closes only the caller's active task", async () => {
		const ctx = createTaskContext("task-complete");
		const task = await ctx.store.addTask({
			userId: ctx.callerId,
			threadIdCreated: "thread-old",
			listName: "today",
			title: "Close the loop",
		});
		const tool = createTaskCompleteTool(ctx);

		const result = await tool.invoke({ taskId: task.id });
		expect(result).toContain(`Completed task ${task.id}.`);

		const completed = await ctx.store.getTask(task.id, ctx.callerId);
		expect(completed).toMatchObject({
			status: "completed",
			threadIdCompleted: "thread-active",
		});
		await ctx.db.close();
	});

	test("task_dismiss requires explicit confirmation in the current turn", async () => {
		const ctx = createTaskContext("task-dismiss-unconfirmed");
		const task = await ctx.store.addTask({
			userId: ctx.callerId,
			threadIdCreated: "thread-old",
			listName: "backlog",
			title: "Drop stale work",
		});
		const tool = createTaskDismissTool(ctx);
		const result = await tool.invoke({
			taskId: task.id,
			reason: "superseded",
		});

		expect(result).toContain("was not dismissed");
		expect(result).toContain("Explicit confirmation is required");
		expect(await ctx.store.getTask(task.id, ctx.callerId)).toMatchObject({
			status: "active",
		});
		await ctx.db.close();
	});

	test("task_dismiss records a dismissal reason after explicit confirmation", async () => {
		const ctx = createTaskContext(
			"task-dismiss",
			"telegram:1",
			"yes, dismiss task 1",
		);
		const task = await ctx.store.addTask({
			userId: ctx.callerId,
			threadIdCreated: "thread-old",
			listName: "backlog",
			title: "Drop stale work",
		});
		const tool = createTaskDismissTool({
			...ctx,
			currentUserText: `yes, dismiss task ${task.id}`,
		});

		const result = await tool.invoke({
			taskId: task.id,
			reason: "superseded",
		});
		expect(result).toContain("Dismissed task");
		expect(result).toContain("Reason: superseded");

		const dismissed = await ctx.store.getTask(task.id, ctx.callerId);
		expect(dismissed).toMatchObject({
			status: "dismissed",
			statusReason: "superseded",
		});
		await ctx.db.close();
	});

	test("task_list_active renders a compact snapshot", async () => {
		const ctx = createTaskContext("task-list");
		await ctx.store.addTask({
			userId: ctx.callerId,
			threadIdCreated: "thread-a",
			listName: "today",
			title: "First task",
		});
		await ctx.store.addTask({
			userId: ctx.callerId,
			threadIdCreated: "thread-b",
			listName: "backlog",
			title: "Second task",
			note: "With note",
		});
		const tool = createTaskListActiveTool(ctx);

		const result = await tool.invoke({ limit: 1 });
		expect(result).toContain("## Active tasks");
		expect(result).toContain("backlog: Second task");
		expect(result).toContain("1 more active task");
		await ctx.db.close();
	});

	test("task_list_active uses the default compact limit", async () => {
		const ctx = createTaskContext("task-list-default");
		for (let index = 1; index <= 14; index += 1) {
			await ctx.store.addTask({
				userId: ctx.callerId,
				threadIdCreated: `thread-${index}`,
				listName: "today",
				title: `Task ${index}`,
			});
		}
		const tool = createTaskListActiveTool(ctx);

		const result = await tool.invoke({});
		expect(result.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(
			12,
		);
		expect(result).toContain("2 more active task(s).");
		await ctx.db.close();
	});
});

describe("createExecutionToolset", () => {
	test("registers task tools when task context is available", async () => {
		const ctx = createTaskContext("factory-task-tools");

		const tools = await createExecutionToolset({
			workspace: ctx.workspace,
			enableExecute: false,
			callerId: ctx.callerId,
			threadId: "thread-current",
			taskStore: ctx.store,
		});

		const names = tools.map((tool) => tool.name);
		expect(names).toContain("task_add");
		expect(names).toContain("task_complete");
		expect(names).toContain("task_dismiss");
		expect(names).toContain("task_list_active");
		await ctx.db.close();
	});
});
