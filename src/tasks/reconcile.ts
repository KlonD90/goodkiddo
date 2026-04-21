import { compactInline } from "../utils/text";
import type { TaskRecord, TaskStore } from "./store";

type MatchKind = "id" | "title_phrase" | "note_phrase";

type TaskMatch = {
	task: TaskRecord;
	match: MatchKind;
};

export type TaskBoundaryReconciliationResult =
	| { kind: "none" }
	| {
			kind: "completed";
			task: TaskRecord;
			agentContext: string;
	  }
	| {
			kind: "dismiss_confirmation";
			tasks: TaskRecord[];
			reply: string;
	  };

const COMPLETION_MARKERS = [
	" done ",
	" finished ",
	" completed ",
	" shipped ",
	" resolved ",
	" fixed ",
	" wrapped up ",
	" closed out ",
	" closed ",
] as const;

const DISMISS_MARKERS = [
	" dont need ",
	" do not need ",
	" no longer need ",
	" not doing ",
	" wont do ",
	" will not do ",
	" stop working on ",
] as const;

const DISMISS_WORD_MARKERS = [
	" skip ",
	" cancel ",
	" drop ",
	" ignore ",
	" forget ",
	" abandon ",
	" shelve ",
] as const;

function normalizeText(value: string): string {
	return ` ${value
		.toLowerCase()
		.replace(/['']/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()} `;
}

function hasMarker(text: string, markers: readonly string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

function hasWordMarker(text: string, markers: readonly string[]): boolean {
	return markers.some((marker) => {
		const trimmed = marker.trim();
		const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "i");
		return pattern.test(text);
	});
}

function hasCompletionIntent(message: string): boolean {
	if (
		message.includes(" not done") ||
		message.includes(" isnt done") ||
		message.includes(" is not done") ||
		message.includes(" didn't ") ||
		message.includes(" dont ") ||
		message.includes(" doesn't ") ||
		message.includes(" isn't ") ||
		message.includes(" aren't ") ||
		message.includes(" wasn't ") ||
		message.includes(" weren't ") ||
		message.includes(" hasn't ") ||
		message.includes(" haven't ") ||
		message.includes(" hadn't ") ||
		message.includes(" not completed") ||
		message.includes(" not finished") ||
		message.includes(" hasn't been done") ||
		message.includes(" haven't been done") ||
		message.includes(" hadn't been done") ||
		message.includes(" not done yet") ||
		message.includes(" not yet done")
	) {
		return false;
	}
	return hasMarker(message, COMPLETION_MARKERS);
}

function hasDismissIntent(message: string): boolean {
	return (
		hasMarker(message, DISMISS_MARKERS) ||
		hasWordMarker(message, DISMISS_WORD_MARKERS)
	);
}

function extractReferencedTaskId(message: string): number | null {
	const match = /\btask\s+#?(\d+)\b/.exec(message);
	if (!match) return null;
	const value = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(value) ? value : null;
}

function formatTaskLabel(task: TaskRecord): string {
	const note = task.note ? ` — ${compactInline(task.note)}` : "";
	return `[${task.id}] ${task.listName}: ${compactInline(task.title)}${note}`;
}

function findTaskMatches(message: string, activeTasks: TaskRecord[]): TaskMatch[] {
	const matches: TaskMatch[] = [];
	const referencedTaskId = extractReferencedTaskId(message);
	if (referencedTaskId !== null) {
		const byId = activeTasks.find((task) => task.id === referencedTaskId);
		if (byId) return [{ task: byId, match: "id" }];
	}

	const normalizedMessage = normalizeText(message);
	for (const task of activeTasks) {
		const normalizedTitle = normalizeText(task.title).trim();
		if (normalizedTitle.length >= 4) {
			const escaped = normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "i");
			if (pattern.test(normalizedMessage)) {
				matches.push({ task, match: "title_phrase" });
				continue;
			}
		}

		if (task.note) {
			const normalizedNote = normalizeText(task.note).trim();
			if (normalizedNote.length >= 6) {
				const escaped = normalizedNote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const pattern = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`, "i");
				if (pattern.test(normalizedMessage)) {
					matches.push({ task, match: "note_phrase" });
				}
			}
		}
	}

	return matches;
}

function buildCompletionAgentContext(task: TaskRecord): string {
	return [
		"## Boundary task reconciliation",
		`- Automatically completed active task ${formatTaskLabel(task)} based on the user's boundary message.`,
		"- Continue helping with the user's request. Do not ask whether this task should be completed again unless the user reopens it.",
	].join("\n");
}

function buildDismissConfirmationReply(tasks: TaskRecord[]): string {
	const lines = [
		tasks.length === 1
			? "I think you want to dismiss this active task, but I won't change it without confirmation:"
			: "I think you want to dismiss one of these active tasks, but I won't change anything without confirmation:",
		...tasks.map((task) => `- ${formatTaskLabel(task)}`),
	];
	if (tasks.length === 1) {
		lines.push(`Reply with "yes, dismiss task ${tasks[0]?.id}" to confirm.`);
	} else {
		lines.push(
			'Reply with the specific task id to dismiss, for example "yes, dismiss task 12".',
		);
	}
	return lines.join("\n");
}

export async function reconcileActiveTasksAtBoundary(params: {
	store: TaskStore;
	userId: string;
	threadId: string;
	messageText: string;
}): Promise<TaskBoundaryReconciliationResult> {
	const activeTasks = await params.store.listActiveTasks(params.userId);
	if (activeTasks.length === 0) {
		return { kind: "none" };
	}

	const normalizedMessage = normalizeText(params.messageText);
	if (normalizedMessage.trim() === "") {
		return { kind: "none" };
	}

	const taskMatches = findTaskMatches(normalizedMessage, activeTasks);
	const dismissIntent = hasDismissIntent(normalizedMessage);
	if (dismissIntent && taskMatches.length > 0) {
		return {
			kind: "dismiss_confirmation",
			tasks: taskMatches.map(({ task }) => task),
			reply: buildDismissConfirmationReply(taskMatches.map(({ task }) => task)),
		};
	}

	if (!hasCompletionIntent(normalizedMessage) || taskMatches.length !== 1) {
		return { kind: "none" };
	}

	const task = taskMatches[0]?.task;
	if (!task) return { kind: "none" };

	const completed = await params.store.completeTask({
		taskId: task.id,
		userId: params.userId,
		threadIdCompleted: params.threadId,
	});
	if (!completed) {
		return { kind: "none" };
	}

	return {
		kind: "completed",
		task: completed,
		agentContext: buildCompletionAgentContext(completed),
	};
}
