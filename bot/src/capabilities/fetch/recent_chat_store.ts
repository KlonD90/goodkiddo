import { createLogger } from "../../logger";
import { compactInline } from "../../utils/text";

const log = createLogger("fetch.recent_chat_store");

type SQL = InstanceType<typeof Bun.SQL>;

export interface RecentChatMessage {
	id: number;
	callerId: string;
	chatId: string;
	messageId: string | null;
	senderLabel: string | null;
	text: string;
	kind: string;
	messageTimestamp: number | null;
	createdAt: number;
}

type RecentChatMessageRow = {
	id: number;
	caller_id: string;
	chat_id: string;
	message_id: string | null;
	sender_label: string | null;
	text: string;
	kind: string;
	message_timestamp: number | null;
	created_at: number;
};

export interface RecentChatStoreOptions {
	db: SQL;
	dialect: "sqlite" | "postgres";
	now?: () => number;
}

export interface RecordRecentChatMessageInput {
	callerId: string;
	chatId: string;
	messageId?: string | number | null;
	senderLabel?: string | null;
	text: string;
	kind?: string;
	messageTimestamp?: number | null;
}

export interface ListRecentChatMessagesOptions {
	limit?: number;
}

function rowToRecentChatMessage(
	row: RecentChatMessageRow,
): RecentChatMessage {
	return {
		id: row.id,
		callerId: row.caller_id,
		chatId: row.chat_id,
		messageId: row.message_id,
		senderLabel: row.sender_label,
		text: row.text,
		kind: row.kind,
		messageTimestamp: row.message_timestamp,
		createdAt: row.created_at,
	};
}

function requireCompactField(value: string, label: string): string {
	const compacted = compactInline(value);
	if (compacted === "") {
		throw new Error(`${label} cannot be empty.`);
	}
	return compacted;
}

function compactOptionalField(value?: string | number | null): string | null {
	if (value == null) return null;
	const compacted = compactInline(String(value));
	return compacted === "" ? null : compacted;
}

function normalizeLimit(limit?: number): number {
	if (limit == null) return 50;
	if (!Number.isFinite(limit) || limit <= 0) return 0;
	return Math.floor(limit);
}

export class RecentChatStore {
	private readonly db: SQL;
	private readonly dialect: "sqlite" | "postgres";
	private readonly now: () => number;
	private readonly _ready: Promise<void>;

	constructor(options: RecentChatStoreOptions) {
		this.db = options.db;
		this.dialect = options.dialect;
		this.now = options.now ?? (() => Date.now());
		this._ready = this.init();
		this._ready.catch((err) => {
			log.error("initialization failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	private async init(): Promise<void> {
		if (this.dialect === "postgres") {
			await this.db`
				CREATE TABLE IF NOT EXISTS fetch_recent_chat_messages (
					id SERIAL PRIMARY KEY,
					caller_id TEXT NOT NULL,
					chat_id TEXT NOT NULL,
					message_id TEXT,
					sender_label TEXT,
					text TEXT NOT NULL,
					kind TEXT NOT NULL,
					message_timestamp BIGINT,
					created_at BIGINT NOT NULL
				)
			`;
		} else {
			await this.db`
				CREATE TABLE IF NOT EXISTS fetch_recent_chat_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					caller_id TEXT NOT NULL,
					chat_id TEXT NOT NULL,
					message_id TEXT,
					sender_label TEXT,
					text TEXT NOT NULL,
					kind TEXT NOT NULL,
					message_timestamp INTEGER,
					created_at INTEGER NOT NULL
				)
			`;
		}

		await this.db`
			CREATE INDEX IF NOT EXISTS idx_fetch_recent_chat_messages_caller_created_at
			ON fetch_recent_chat_messages(caller_id, created_at DESC)
		`;

		if (this.dialect === "sqlite") {
			await this.db`PRAGMA journal_mode = WAL`;
		}
	}

	async ready(): Promise<void> {
		await this._ready;
	}

	async recordMessage(
		input: RecordRecentChatMessageInput,
	): Promise<RecentChatMessage> {
		await this._ready;
		const callerId = requireCompactField(input.callerId, "Caller id");
		const chatId = requireCompactField(input.chatId, "Chat id");
		const text = requireCompactField(
			input.text,
			"Recent chat message text",
		);
		const kind = compactOptionalField(input.kind) ?? "text";
		const messageId = compactOptionalField(input.messageId);
		const senderLabel = compactOptionalField(input.senderLabel);
		const now = this.now();

		const rows = await this.db<RecentChatMessageRow[]>`
			INSERT INTO fetch_recent_chat_messages (
				caller_id,
				chat_id,
				message_id,
				sender_label,
				text,
				kind,
				message_timestamp,
				created_at
			) VALUES (
				${callerId},
				${chatId},
				${messageId},
				${senderLabel},
				${text},
				${kind},
				${input.messageTimestamp ?? null},
				${now}
			)
			RETURNING
				id,
				caller_id,
				chat_id,
				message_id,
				sender_label,
				text,
				kind,
				message_timestamp,
				created_at
		`;
		const row = rows[0];
		if (!row) throw new Error("Failed to record recent chat message");
		return rowToRecentChatMessage(row);
	}

	async listRecentMessages(
		callerId: string,
		options: ListRecentChatMessagesOptions = {},
	): Promise<RecentChatMessage[]> {
		await this._ready;
		const normalizedCallerId = requireCompactField(callerId, "Caller id");
		const limit = normalizeLimit(options.limit);
		if (limit === 0) return [];

		const rows = await this.db<RecentChatMessageRow[]>`
			SELECT
				id,
				caller_id,
				chat_id,
				message_id,
				sender_label,
				text,
				kind,
				message_timestamp,
				created_at
			FROM (
				SELECT
					id,
					caller_id,
					chat_id,
					message_id,
					sender_label,
					text,
					kind,
					message_timestamp,
					created_at
				FROM fetch_recent_chat_messages
				WHERE caller_id = ${normalizedCallerId}
				ORDER BY created_at DESC, id DESC
				LIMIT ${limit}
			) recent_messages
			ORDER BY created_at ASC, id ASC
		`;

		return rows.map(rowToRecentChatMessage);
	}

	async pruneOldMessages(
		callerId: string,
		olderThanMs: number,
	): Promise<number> {
		await this._ready;
		const normalizedCallerId = requireCompactField(callerId, "Caller id");
		if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
			throw new Error("Prune age must be a non-negative number.");
		}
		const cutoff = this.now() - olderThanMs;
		const rows = await this.db<Array<{ id: number }>>`
			SELECT id
			FROM fetch_recent_chat_messages
			WHERE caller_id = ${normalizedCallerId}
				AND created_at < ${cutoff}
		`;

		await this.db`
			DELETE FROM fetch_recent_chat_messages
			WHERE caller_id = ${normalizedCallerId}
				AND created_at < ${cutoff}
		`;

		return rows.length;
	}
}
