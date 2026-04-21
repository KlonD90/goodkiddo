import { CronExpressionParser } from "cron-parser";
import type { TimerStore, TimerRecord } from "./store.js";

export interface SchedulerOptions {
	intervalMs: number;
	readMdFile: (path: string) => Promise<string>;
	onTick: (timer: TimerRecord, promptText: string) => Promise<void>;
	notifyUser: (userId: string, message: string) => Promise<void>;
}

function computeNextRunAt(cronExpression: string, fromDate: Date = new Date()): number {
	const expr = CronExpressionParser.parse(cronExpression, { currentDate: fromDate });
	return expr.next().getTime();
}

export function startScheduler(
	store: TimerStore,
	options: SchedulerOptions,
): { stop: () => void } {
	const { intervalMs, readMdFile, onTick, notifyUser } = options;
	let stopped = false;
	let intervalId: ReturnType<typeof setInterval> | null = null;

	async function tick(): Promise<void> {
		if (stopped) return;

		const dueTimers = await store.findDue();

		for (const timer of dueTimers) {
			if (stopped) return;

			let promptText: string;
			try {
				promptText = await readMdFile(timer.mdFilePath);
			} catch {
				await store.delete(timer.id, timer.userId);
				await notifyUser(
					timer.userId,
					`Timer for '${timer.mdFilePath}' was deleted because the memory file no longer exists.`,
				);
				continue;
			}

			try {
				await onTick(timer, promptText);
				const nextRunAt = computeNextRunAt(timer.cronExpression);
				await store.touchRun(timer.id, nextRunAt);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const consecutiveFailures = await store.touchError(timer.id, message);
				if (consecutiveFailures >= 3) {
					await notifyUser(
						timer.userId,
						`Timer '${timer.mdFilePath}' has failed 3 times in a row. Last error: ${message}. The timer will continue running.`,
					);
				}
			}
		}
	}

	function stop(): void {
		stopped = true;
		if (intervalId !== null) {
			clearInterval(intervalId);
			intervalId = null;
		}
	}

	intervalId = setInterval(tick, intervalMs);
	tick();

	return { stop };
}
