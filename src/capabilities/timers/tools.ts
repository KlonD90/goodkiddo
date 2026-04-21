import { tool } from "langchain";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { resolve } from "node:path";
import type { TimerStore, TimerRecord } from "./store.js";

export interface TimerToolsOptions {
	timezone: string;
	computeNextRun: (cronExpression: string, fromDate?: Date) => number;
	readMdFile: (path: string) => Promise<string>;
	callerId: string;
}

function isValidMemoryPath(path: string): boolean {
	if (!path) return false;
	const trimmed = path.trim();
	if (trimmed === "") return false;
	if (trimmed.includes("..")) return false;
	if (trimmed.startsWith("/")) {
		return trimmed.startsWith("/memory/");
	}
	return true;
}

function formatInTimezone(timestamp: number, timezone: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(timestamp));
}

function formatTimerList(timers: TimerRecord[]): string {
	if (timers.length === 0) {
		return "No active timers.";
	}
	return timers
		.map((t) => {
			const nextRun = formatInTimezone(t.nextRunAt, t.timezone);
			const lastRun = t.lastRunAt
				? formatInTimezone(t.lastRunAt, t.timezone)
				: "never";
			return `- ${t.id}: ${t.mdFilePath} (${t.cronExpression}) next=${nextRun} (${t.timezone}) last=${lastRun} failures=${t.consecutiveFailures}`;
		})
		.join("\n");
}

export function createTimerTools(
	store: TimerStore,
	options: TimerToolsOptions,
) {
	const createTimerTool = tool(
		async ({
			mdFilePath,
			cronExpression,
			timezone,
		}: {
			mdFilePath: string;
			cronExpression: string;
			timezone?: string;
		}) => {
			if (!isValidMemoryPath(mdFilePath)) {
				return "Error: Memory file path must be inside /memory/";
			}

			let parsedExpr: ReturnType<typeof CronExpressionParser.parse>;
			try {
				parsedExpr = CronExpressionParser.parse(cronExpression, {
					currentDate: new Date(),
				});
				parsedExpr.next();
			} catch {
				return "Error: Invalid schedule. Try '0 10 * * 1-5' for every workday at 10 AM.";
			}

			let fileContents: string;
			try {
				fileContents = await options.readMdFile(mdFilePath);
			} catch {
				return `Error: Memory file not found: ${mdFilePath}`;
			}

			const effectiveTimezone = timezone ?? options.timezone;
			const nextRunAt = options.computeNextRun(cronExpression);

			const timer = await store.create({
				userId: options.callerId,
				chatId: options.callerId,
				mdFilePath,
				cronExpression,
				timezone: effectiveTimezone,
				nextRunAt,
			});

			const nextRunDate = formatInTimezone(nextRunAt, effectiveTimezone);
			return `Timer set. I'll run \`${mdFilePath}\` with cron \`${cronExpression}\` (${effectiveTimezone}) next at ${nextRunDate}. Timer ID: ${timer.id}`;
		},
		{
			name: "create_timer",
			description: `Create a scheduled timer that runs a memory file on a cron schedule.

The timer executes the content of the specified memory file as a prompt and sends
the result to the user's chat. Timers persist across restarts.

Args:
- mdFilePath: path to the memory file inside /memory/ directory
- cronExpression: cron schedule (e.g., "0 10 * * 1-5" for weekdays at 10 AM)
- timezone: optional timezone override (defaults to the user's configured timezone)

Cron format: minute hour day-of-month month day-of-week
Examples:
  "0 10 * * 1-5" = every weekday at 10 AM
  "*/15 * * * *" = every 15 minutes
  "0 9 * * *" = every day at 9 AM`,
			schema: z.object({
				mdFilePath: z
					.string()
					.describe("Path to the memory file inside /memory/ (e.g., 'daily-news.md' or '/memory/daily-news.md')"),
				cronExpression: z
					.string()
					.describe("Cron expression: minute hour day-of-month month day-of-week (e.g., '0 10 * * 1-5' for weekdays at 10 AM)"),
				timezone: z
					.string()
					.optional()
					.describe("Timezone for the schedule (e.g., 'America/New_York'). Defaults to the user's configured timezone."),
			}),
		},
	);

	const listTimersTool = tool(
		async () => {
			const timers = await store.findByUser(options.callerId);
			if (timers.length === 0) {
				return "No active timers.";
			}
			return formatTimerList(timers);
		},
		{
			name: "list_timers",
			description: `List all timers belonging to the current user.

Returns timer ID, memory file path, cron expression, timezone, next run time,
last run time, and consecutive failure count for each timer.`,
			schema: z.object({}),
		},
	);

	const updateTimerTool = tool(
		async ({
			timerId,
			cronExpression,
			timezone,
			enabled,
		}: {
			timerId: string;
			cronExpression?: string;
			timezone?: string;
			enabled?: boolean;
		}) => {
			const existing = await store.getById(timerId);
			if (!existing || existing.userId !== options.callerId) {
				return `Error: Timer ${timerId} not found or access denied.`;
			}

			if (cronExpression) {
				try {
					CronExpressionParser.parse(cronExpression, { currentDate: new Date() }).next();
				} catch {
					return "Error: Invalid schedule. Try '0 10 * * 1-5' for every workday at 10 AM.";
				}
			}

			const updated = await store.update(timerId, options.callerId, {
				cronExpression,
				timezone,
				enabled,
			});

			if (!updated) {
				return `Error: Timer ${timerId} not found or access denied.`;
			}

			if (cronExpression) {
				const nextRunAt = options.computeNextRun(cronExpression);
				await store.touchRun(timerId, nextRunAt);
			}

			const changes: string[] = [];
			if (cronExpression) changes.push(`cron expression changed to '${cronExpression}'`);
			if (timezone) changes.push(`timezone changed to '${timezone}'`);
			if (enabled !== undefined) changes.push(`enabled changed to ${enabled}`);

			if (changes.length === 0) {
				return "No changes provided.";
			}

			return `Timer ${timerId} updated: ${changes.join(", ")}.`;
		},
		{
			name: "update_timer",
			description: `Update an existing timer's schedule, timezone, or enabled state.

Only provided fields are updated. If cron expression changes, next run time is recomputed.`,
			schema: z.object({
				timerId: z.string().describe("ID of the timer to update"),
				cronExpression: z
					.string()
					.optional()
					.describe("New cron expression (e.g., '0 14 * * *' for 2 PM daily)"),
				timezone: z
					.string()
					.optional()
					.describe("New timezone (e.g., 'America/New_York')"),
				enabled: z.boolean().optional().describe("Enable or disable the timer"),
			}),
		},
	);

	const deleteTimerTool = tool(
		async ({ timerId }: { timerId: string }) => {
			const deleted = await store.delete(timerId, options.callerId);
			if (!deleted) {
				return `Error: Timer ${timerId} not found or access denied.`;
			}
			return `Timer deleted.`;
		},
		{
			name: "delete_timer",
			description: `Delete a scheduled timer permanently.

The timer is hard-deleted from the database. This action cannot be undone.`,
			schema: z.object({
				timerId: z.string().describe("ID of the timer to delete"),
			}),
		},
	);

	return [createTimerTool, listTimersTool, updateTimerTool, deleteTimerTool];
}