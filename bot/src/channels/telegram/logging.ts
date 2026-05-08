const ERROR_META_KEYS = [
	"code",
	"errno",
	"detail",
	"hint",
	"where",
	"schema",
	"table",
	"column",
	"constraint",
	"severity",
	"routine",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function primitive(value: unknown): string | number | boolean | null | undefined {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null ||
		value === undefined
	) {
		return value;
	}
	return undefined;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export function errorFieldsForLog(error: unknown): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	if (error instanceof Error) {
		fields.error = error.message;
		fields.errorName = error.name;
		fields.errorStack = error.stack;
		if (error.cause !== undefined) {
			fields.errorCause =
				error.cause instanceof Error ? error.cause.message : String(error.cause);
		}
	} else {
		fields.error = String(error);
	}

	const record = asRecord(error);
	if (!record) return fields;

	for (const key of ERROR_META_KEYS) {
		const value = primitive(record[key]);
		if (value !== undefined) {
			fields[`error${capitalize(key)}`] = value;
		}
	}
	return fields;
}

function idField(value: unknown): string | undefined {
	if (typeof value === "number" || typeof value === "string") {
		return String(value);
	}
	return undefined;
}

function stringLength(value: unknown): number | undefined {
	return typeof value === "string" ? value.length : undefined;
}

function firstPresentKey(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	return keys.find((key) => record[key] !== undefined);
}

function setField(
	fields: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	if (value !== undefined) fields[key] = value;
}

function summarizeMessage(
	message: Record<string, unknown> | null,
	fields: Record<string, unknown>,
): void {
	if (!message) return;

	const chat = asRecord(message.chat);
	const from = asRecord(message.from);
	setField(fields, "chatId", idField(chat?.id));
	setField(fields, "chatType", primitive(chat?.type));
	setField(fields, "fromId", idField(from?.id));
	setField(fields, "messageId", primitive(message.message_id));
	setField(fields, "messageDate", primitive(message.date));
	setField(fields, "textLength", stringLength(message.text));
	setField(fields, "captionLength", stringLength(message.caption));

	const messageKind = firstPresentKey(message, [
		"text",
		"photo",
		"voice",
		"document",
		"audio",
		"video",
		"sticker",
		"location",
	]);
	setField(fields, "messageKind", messageKind);

	const document = asRecord(message.document);
	if (document) {
		setField(fields, "documentFileName", primitive(document.file_name));
		setField(fields, "documentMimeType", primitive(document.mime_type));
		setField(fields, "documentFileSize", primitive(document.file_size));
	}

	const voice = asRecord(message.voice);
	if (voice) {
		setField(fields, "voiceFileSize", primitive(voice.file_size));
		setField(fields, "voiceDuration", primitive(voice.duration));
	}

	if (Array.isArray(message.photo)) {
		fields.photoCount = message.photo.length;
	}
}

export function summarizeTelegramUpdateForLog(
	update: unknown,
): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	const record = asRecord(update);
	if (!record) return fields;

	setField(fields, "updateId", primitive(record.update_id));
	const updateType = firstPresentKey(record, [
		"message",
		"edited_message",
		"callback_query",
		"channel_post",
		"edited_channel_post",
	]);
	setField(fields, "updateType", updateType);

	if (updateType === "callback_query") {
		const callback = asRecord(record.callback_query);
		setField(fields, "callbackQueryId", idField(callback?.id));
		setField(fields, "callbackDataLength", stringLength(callback?.data));
		if (typeof callback?.data === "string") {
			fields.callbackDataPrefix = callback.data.slice(0, 32);
		}
		setField(fields, "fromId", idField(asRecord(callback?.from)?.id));
		summarizeMessage(asRecord(callback?.message), fields);
		return fields;
	}

	summarizeMessage(
		asRecord(record.message) ??
			asRecord(record.edited_message) ??
			asRecord(record.channel_post) ??
			asRecord(record.edited_channel_post),
		fields,
	);
	return fields;
}
