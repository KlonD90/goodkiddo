import { context, tool } from "langchain";
import { z } from "zod";
import { formatActiveTaskSnapshot, type TaskStore } from "../tasks/store";
import { compactInline } from "../utils/text";

const TASK_ADD_PROMPT = context`Create a caller-scoped active task in SQL.

Use this for actionable work that should remain open across turns or sessions:
follow-ups, TODOs, checklists, pending user requests, and other incomplete work.

Do not use this for durable facts, preferences, or reusable procedures. Those
still belong in memory_write or skill_write.`;

const TASK_COMPLETE_PROMPT = context`Mark one active task as completed.

Use when the task's work is actually done. This records the current thread as
the completion boundary.`;

const TASK_DISMISS_PROMPT = context`Dismiss one active task without completing it.

Use when the task is no longer relevant, was superseded, or should be dropped.
Include a short reason when you have one.`;

const TASK_LIST_ACTIVE_PROMPT = context`List the caller's current active tasks.

Use this when you need the latest SQL-backed task state before planning or
closing a loop.`;

function normalizeTurnText(value: string | undefined): string {
	return value
		?.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim() ?? "";
}

function hasDismissConfirmation(
	currentUserText: string | undefined,
	taskId: number,
): boolean {
	const normalized = normalizeTurnText(currentUserText);
	if (normalized === "") return false;
	return new RegExp(
		`^(?:yes|confirm|confirmed)(?:\\s+please)?\\s+dismiss\\s+task\\s+${taskId}$`,
		"i",
	).test(normalized);
}

function formatTaskLine(task: {
	id: number;
	listName: string;
	title: string;
	note: string | null;
}): string {
	const note = task.note ? `\nNote: ${compactInline(task.note)}` : "";
	return `- [${task.id}] ${task.listName}: ${compactInline(task.title)}${note}`;
}

export interface TaskToolContext {
	store: TaskStore;
	callerId: string;
	threadId: string;
	currentUserText?: string;
}

export function createTaskAddTool(contextValue: TaskToolContext) {
	return tool(
		async ({
			listName,
			title,
			note,
		}: {
			listName: string;
			title: string;
			note?: string;
		}) => {
			try {
				const task = await contextValue.store.addTask({
					userId: contextValue.callerId,
					threadIdCreated: contextValue.threadId,
					listName,
					title,
					note,
				});
				return [
					`Added active task ${task.id}.`,
					formatTaskLine(task),
				].join("\n");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
		{
			name: "task_add",
			description: TASK_ADD_PROMPT,
			schema: z.object({
				listName: z
					.string()
					.trim()
					.min(1)
					.describe("Task list name, such as today, backlog, or follow-up."),
				title: z
					.string()
					.trim()
					.min(1)
					.describe("Short actionable task title."),
				note: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe("Optional implementation detail or reminder."),
			}),
		},
	);
}

export function createTaskCompleteTool(contextValue: TaskToolContext) {
	return tool(
		async ({ taskId }: { taskId: number }) => {
			try {
				const task = await contextValue.store.completeTask({
					taskId,
					userId: contextValue.callerId,
					threadIdCompleted: contextValue.threadId,
				});
				if (!task) {
					return `Task ${taskId} was not found, does not belong to this caller, or is already closed.`;
				}
				return [
					`Completed task ${task.id}.`,
					formatTaskLine(task),
				].join("\n");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
		{
			name: "task_complete",
			description: TASK_COMPLETE_PROMPT,
			schema: z.object({
				taskId: z.number().int().positive().describe("Active task id to complete."),
			}),
		},
	);
}

export function createTaskDismissTool(contextValue: TaskToolContext) {
	return tool(
		async ({ taskId, reason }: { taskId: number; reason?: string }) => {
			try {
				if (!hasDismissConfirmation(contextValue.currentUserText, taskId)) {
					return [
						`Task ${taskId} was not dismissed.`,
						'Explicit confirmation is required. Ask the user to reply with "yes, dismiss task <id>" before using task_dismiss.',
					].join("\n");
				}
				const task = await contextValue.store.dismissTask({
					taskId,
					userId: contextValue.callerId,
					reason,
				});
				if (!task) {
					return `Task ${taskId} was not found, does not belong to this caller, or is already closed.`;
				}
				const reasonLine = task.statusReason
					? `Reason: ${compactInline(task.statusReason)}`
					: null;
				return [
					`Dismissed task ${task.id}.`,
					formatTaskLine(task),
					...(reasonLine ? [reasonLine] : []),
				].join("\n");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
		{
			name: "task_dismiss",
			description: TASK_DISMISS_PROMPT,
			schema: z.object({
				taskId: z.number().int().positive().describe("Active task id to dismiss."),
				reason: z
					.string()
					.trim()
					.min(1)
					.optional()
					.describe("Optional short reason for dismissal."),
			}),
		},
	);
}

export function createTaskListActiveTool(contextValue: TaskToolContext) {
	return tool(
		async ({ limit }: { limit?: number }) => {
			try {
				const resolvedLimit = limit ?? 12;
				const [tasks, totalCount] = await Promise.all([
					contextValue.store.listActiveTasks(
						contextValue.callerId,
						resolvedLimit,
					),
					contextValue.store.countTasksForUser(contextValue.callerId, {
						status: "active",
					}),
				]);
				return formatActiveTaskSnapshot(tasks, {
					heading: "## Active tasks",
					limit: resolvedLimit,
					totalCount,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
		{
			name: "task_list_active",
			description: TASK_LIST_ACTIVE_PROMPT,
			schema: z.object({
				limit: z
					.number()
					.int()
					.positive()
					.max(100)
					.optional()
					.describe("Maximum number of active tasks to return. Defaults to 12."),
			}),
		},
	);
}
