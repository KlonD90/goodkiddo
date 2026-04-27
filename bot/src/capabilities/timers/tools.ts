import { tool } from "langchain";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import { isValidTimezone } from "../../utils/timezone.js";
import type { TimerStore, TimerRecord } from "./store.js";

export interface TimerToolsOptions {
	computeNextRun: (
		cronExpression: string,
		timezone: string,
		fromDate?: Date,
	) => number;
	readMdFile: (path: string) => Promise<string>;
	callerId: string;
	chatId?: string;
}

const createOnceTimerSchema = z.object({
	type: z.literal("once"),
	message: z.string().min(1).describe("Reminder text to send once."),
	runAtUtc: z
		.string()
		.min(1)
		.describe("UTC ISO timestamp for the reminder, e.g. '2026-04-24T12:30:00.000Z'."),
});

const createAlwaysTimerSchema = z.object({
	type: z.literal("always"),
	mdFilePath: z
		.string()
		.min(1)
		.describe("Path to the memory file inside /memory/ (e.g., 'daily-news.md' or '/memory/daily-news.md')"),
	cronExpression: z
		.string()
		.min(1)
		.describe("Cron expression: minute hour day-of-month month day-of-week (e.g., '0 10 * * 1-5' for weekdays at 10 AM)"),
	timezone: z
		.string()
		.min(1)
		.describe("IANA timezone for the recurring schedule, e.g. 'America/New_York'."),
});

const createTimerSchema = z.discriminatedUnion("type", [
	createOnceTimerSchema,
	createAlwaysTimerSchema,
]);

type CreateTimerInput = z.infer<typeof createTimerSchema>;

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

function parseRunAtUtc(runAtUtc: string): number | null {
	const parsed = new Date(runAtUtc);
	const timestamp = parsed.getTime();
	return Number.isNaN(timestamp) ? null : timestamp;
}

function cronExpressionFromUtcTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	return [
		date.getUTCMinutes(),
		date.getUTCHours(),
		date.getUTCDate(),
		date.getUTCMonth() + 1,
		"*",
	].join(" ");
}

function formatTimerList(timers: TimerRecord[]): string {
	const activeTimers = timers.filter((timer) => timer.enabled);
	if (activeTimers.length === 0) {
		return "No active timers.";
	}
	return activeTimers
		.map((t) => {
			const nextRun = formatInTimezone(t.nextRunAt, t.timezone);
			const lastRun = t.lastRunAt
				? formatInTimezone(t.lastRunAt, t.timezone)
				: "never";
			if (t.kind === "once") {
				const message = t.message ?? "(no message)";
				return `- ${t.id}: one-time reminder "${message}" (${t.cronExpression}) next=${nextRun} (${t.timezone}) last=${lastRun} failures=${t.consecutiveFailures}`;
			}
			return `- ${t.id}: ${t.mdFilePath} (${t.cronExpression}) next=${nextRun} (${t.timezone}) last=${lastRun} failures=${t.consecutiveFailures}`;
		})
		.join("\n");
}

export function createTimerTools(
	store: TimerStore,
	options: TimerToolsOptions,
) {
	const createTimerTool = tool(
		async (input: CreateTimerInput) => {
			if (input.type === "once") {
				const trimmedMessage = input.message.trim();
				if (trimmedMessage === "") {
					return "Error: Reminder message cannot be empty.";
				}

				const runAtTimestamp = parseRunAtUtc(input.runAtUtc);
				if (runAtTimestamp === null) {
					return "Error: runAtUtc must be a valid ISO timestamp.";
				}

				const cronExpression = cronExpressionFromUtcTimestamp(runAtTimestamp);
				const timer = await store.create({
					userId: options.callerId,
					chatId: options.chatId ?? options.callerId,
					kind: "once",
					cronExpression,
					message: trimmedMessage,
					timezone: "UTC",
					nextRunAt: runAtTimestamp,
				});

				const nextRunDate = formatInTimezone(runAtTimestamp, "UTC");
				return `One-time reminder set for ${nextRunDate} (UTC). Timer ID: ${timer.id}`;
			}

			const { mdFilePath, cronExpression, timezone } = input;
			if (!isValidTimezone(timezone)) {
				return `Error: Invalid timezone: ${timezone}`;
			}

			try {
				const parsedExpr = CronExpressionParser.parse(cronExpression, {
					currentDate: new Date(),
					tz: timezone,
				});
				parsedExpr.next();
			} catch {
				return "Error: Invalid schedule. Try '0 10 * * 1-5' for every workday at 10 AM.";
			}

			const nextRunAt = options.computeNextRun(
				cronExpression,
				timezone,
			);

			if (!isValidMemoryPath(mdFilePath)) {
				return "Error: Memory file path must be inside /memory/";
			}

			try {
				await options.readMdFile(mdFilePath);
			} catch {
				return `Error: Memory file not found: ${mdFilePath}`;
			}

			const timer = await store.create({
				userId: options.callerId,
				chatId: options.chatId ?? options.callerId,
				mdFilePath,
				cronExpression,
				kind: "always",
				timezone,
				nextRunAt,
			});

			const nextRunDate = formatInTimezone(nextRunAt, timezone);
			return `Timer set. I'll run \`${mdFilePath}\` with cron \`${cronExpression}\` (${timezone}) next at ${nextRunDate}. Timer ID: ${timer.id}`;
		},
		{
			name: "create_timer",
			description: `Create a scheduled timer.

For type "always", the timer executes a memory file on a cron schedule and sends
the LLM result to the user's chat. For type "once", the timer sends a direct
reminder notification once and then marks itself completed. Timers persist across
restarts.

Args:
- type: required discriminator, either "always" or "once"
- For type "once": provide message and runAtUtc. Use the current message timestamp to resolve duration-only requests like "in 30 minutes" into runAtUtc. For wall-clock requests like "tomorrow at 9", use an explicit or stored IANA timezone to compute runAtUtc first. Do not pass timezone to this tool shape.
- For type "always": provide mdFilePath, cronExpression, and timezone. If the user did not provide a timezone and none is stored in /memory/USER.md, ask for it and save it to USER.md before creating the timer.

Cron format: minute hour day-of-month month day-of-week
Examples:
  "0 10 * * 1-5" = every weekday at 10 AM
  "*/15 * * * *" = every 15 minutes
  "0 9 * * *" = every day at 9 AM`,
			schema: createTimerSchema,
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
			const effectiveTimezone = timezone ?? existing.timezone;
			if (!isValidTimezone(effectiveTimezone)) {
				return `Error: Invalid timezone: ${effectiveTimezone}`;
			}

			if (cronExpression) {
				try {
					CronExpressionParser.parse(cronExpression, {
						currentDate: new Date(),
						tz: effectiveTimezone,
					}).next();
				} catch {
					return "Error: Invalid schedule. Try '0 10 * * 1-5' for every workday at 10 AM.";
				}
			}

			const effectiveCronExpression = cronExpression ?? existing.cronExpression;
			const nextRunAt =
				cronExpression || timezone
					? options.computeNextRun(
							effectiveCronExpression,
							effectiveTimezone,
						)
					: undefined;

			const updated = await store.update(timerId, options.callerId, {
				cronExpression,
				timezone,
				enabled,
				nextRunAt,
			});

			if (!updated) {
				return `Error: Timer ${timerId} not found or access denied.`;
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

	return [
		createTimerTool,
		listTimersTool,
		updateTimerTool,
		deleteTimerTool,
	];
}
