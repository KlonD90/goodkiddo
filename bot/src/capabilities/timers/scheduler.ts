import { CronExpressionParser } from "cron-parser";
import { createLogger } from "../../logger";
import type { TimerNotifyMode, TimerRecord, TimerStore } from "./store.js";

export type { TimerNotifyMode };

const log = createLogger("scheduler");

export interface SchedulerOptions {
	intervalMs: number;
	readMdFile: (timer: TimerRecord, path: string) => Promise<string>;
	onTick: (timer: TimerRecord, promptText: string) => Promise<string>;
	notifyUser: (userId: string, message: string) => Promise<void>;
}

export function computeNextRunAt(
	cronExpression: string,
	timezone: string,
	fromDate: Date = new Date(),
): number {
	const expr = CronExpressionParser.parse(cronExpression, {
		currentDate: fromDate,
		tz: timezone,
	});
	return expr.next().getTime();
}

function todayPathDate(): string {
	return new Date().toISOString().slice(0, 10);
}

function formatVerboseEntry(timer: TimerRecord, resultText: string): string {
	return `**${timer.mdFilePath}**\n${resultText}`;
}

function formatSummaryEntry(timer: TimerRecord, resultText: string): string {
	const prefix = resultText.slice(0, 280);
	const date = todayPathDate();
	return `**${timer.mdFilePath}**\n${prefix}… Full result saved to /memory/timers/${timer.id}/${date}.md`;
}

function buildBufferedMessage(entries: string[]): string {
	return entries.join("\n\n");
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

		let dueTimers: TimerRecord[];
		try {
			dueTimers = await store.findDue();
		} catch (err) {
			log.error("tick: findDue failed", {
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		if (dueTimers.length === 0) {
			log.debug("tick: no due timers");
			return;
		}

		log.info("tick: processing due timers", { count: dueTimers.length });

		const chatBuffers = new Map<string, string[]>();

		for (const timer of dueTimers) {
			if (stopped) return;

			if (timer.kind === "once") {
				log.info("reminder firing", {
					timerId: timer.id,
					userId: timer.userId,
					chatId: timer.chatId,
				});
				try {
					const message = timer.message?.trim();
					if (!message) {
						throw new Error("One-time reminder has no message.");
					}
					await notifyUser(timer.chatId, `Reminder: ${message}`);
					await store.touchRun(timer.id, timer.nextRunAt);
					await store.update(timer.id, timer.userId, { enabled: false });
					log.info("reminder sent", { timerId: timer.id });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					log.warn("reminder failed, will retry", {
						timerId: timer.id,
						error: message,
					});
					await store.touchError(timer.id, timer.userId, message);
				}
				continue;
			}

			log.info("timer firing", {
				timerId: timer.id,
				userId: timer.userId,
				path: timer.mdFilePath,
				consecutiveFailures: timer.consecutiveFailures,
			});

			let promptText: string;
			try {
				promptText = await readMdFile(timer, timer.mdFilePath);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log.warn("memory file missing, deleting timer", {
					timerId: timer.id,
					path: timer.mdFilePath,
					error: message,
				});
				await store.delete(timer.id, timer.userId);
				try {
					await notifyUser(
						timer.userId,
						`Timer for '${timer.mdFilePath}' was deleted because the memory file no longer exists.`,
					);
				} catch (notifyErr) {
					log.error("deletion notification failed", {
						timerId: timer.id,
						userId: timer.userId,
						error:
							notifyErr instanceof Error
								? notifyErr.message
								: String(notifyErr),
					});
				}
				continue;
			}

			let resultText: string;
			try {
				resultText = await onTick(timer, promptText);
				const nextRunAt = computeNextRunAt(
					timer.cronExpression,
					timer.timezone,
				);
				await store.touchRun(timer.id, nextRunAt);
				log.info("timer completed", {
					timerId: timer.id,
					nextRunAt: new Date(nextRunAt).toISOString(),
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const nextRunAt = computeNextRunAt(
					timer.cronExpression,
					timer.timezone,
				);
				const consecutiveFailures = await store.touchError(
					timer.id,
					timer.userId,
					message,
					nextRunAt,
				);
				log.error("timer failed", {
					timerId: timer.id,
					path: timer.mdFilePath,
					consecutiveFailures,
					error: message,
					nextRunAt: new Date(nextRunAt).toISOString(),
				});
				if (consecutiveFailures >= 3) {
					log.warn("failure threshold reached, notifying user", {
						timerId: timer.id,
						userId: timer.userId,
						consecutiveFailures,
					});
					try {
						await notifyUser(
							timer.userId,
							`Timer '${timer.mdFilePath}' has failed 3 times in a row. Last error: ${message}. The timer will continue running.`,
						);
					} catch (notifyErr) {
						log.error("failure notification also failed", {
							timerId: timer.id,
							userId: timer.userId,
							error:
								notifyErr instanceof Error
									? notifyErr.message
									: String(notifyErr),
						});
					}
				}
				continue;
			}

			if (resultText.trim() === "") {
				continue;
			}

			if (timer.notify === "verbose") {
				const entry = formatVerboseEntry(timer, resultText);
				const entries = chatBuffers.get(timer.chatId) ?? [];
				entries.push(entry);
				chatBuffers.set(timer.chatId, entries);
			} else if (timer.notify === "summary") {
				const entry = formatSummaryEntry(timer, resultText);
				const entries = chatBuffers.get(timer.chatId) ?? [];
				entries.push(entry);
				chatBuffers.set(timer.chatId, entries);
			}
			// errors_only and silent do not add successful results to the digest.
		}

		for (const [chatId, entries] of chatBuffers) {
			if (entries.length === 0) continue;
			try {
				await notifyUser(chatId, buildBufferedMessage(entries));
			} catch (err) {
				log.error("batched timer notification failed", {
					chatId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	function stop(): void {
		if (stopped) return;
		stopped = true;
		if (intervalId !== null) {
			clearInterval(intervalId);
			intervalId = null;
		}
		log.info("scheduler stopped");
	}

	log.info("scheduler started", { intervalMs });
	intervalId = setInterval(tick, intervalMs);
	tick();

	return { stop };
}
