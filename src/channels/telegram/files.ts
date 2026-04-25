import { extname } from "node:path";
import type { BackendProtocol } from "deepagents";
import type { Bot } from "grammy";
import { saveIncomingAttachment } from "../../capabilities/incoming/save_attachment";
import type { CapabilityRegistry } from "../../capabilities/registry";
import type { FileMetadata } from "../../capabilities/types";
import type { AppConfig } from "../../config";
import type { PermissionsStore } from "../../permissions/store";
import type { Caller } from "../../permissions/types";
import type { ChannelRunOptions } from "../types";
import { buildAttachmentBudgetConfig } from "./attachment";
import { sendTelegramMessage } from "./outbound";
import { createLogger } from "../../logger";

const log = createLogger("telegram");
import type {
	ProcessTelegramFileHelpers,
	TelegramAgentSession,
	TelegramUserInput,
} from "./types";

const INCOMING_IMAGE_EXTENSIONS = new Set([
	"jpg",
	"jpeg",
	"png",
	"webp",
	"gif",
]);

export const IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/gif",
	"image/webp",
	"image/bmp",
	"image/svg+xml",
]);

export function isImageMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	const result = IMAGE_MIME_TYPES.has(normalized);
	log.debug("isImageMimeType", { mimeType, normalized, result });
	return result;
}

function detectTelegramImageMimeType(filePath: string | undefined): string {
	switch (extname(filePath ?? "").toLowerCase()) {
		case ".png":
			return "image/png";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".bmp":
			return "image/bmp";
		default:
			return "image/jpeg";
	}
}

export function extractIncomingExtension(filePath: string | undefined): string {
	const extension = extname(filePath ?? "")
		.slice(1)
		.toLowerCase();
	if (!INCOMING_IMAGE_EXTENSIONS.has(extension)) return "jpg";
	return extension;
}

export function buildIncomingImagePromptText(
	imagePath: string,
	caption: string | null | undefined,
): string {
	const trimmedCaption = typeof caption === "string" ? caption.trim() : "";
	const captionLine =
		trimmedCaption === "" ? "" : `\nCaption: ${JSON.stringify(trimmedCaption)}`;

	return `User attached an image saved at ${imagePath}.${captionLine}

Use the understand_image tool with image_path set to ${imagePath}. Include the user's caption and conversation context in the prompt you send to the image model.`;
}

export function buildTelegramPhotoContent(
	imageData: Uint8Array,
	options?: {
		caption?: string | null;
		filePath?: string;
	},
): Array<
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: Uint8Array }
> {
	const caption =
		typeof options?.caption === "string" ? options.caption.trim() : "";

	return [
		{
			type: "text",
			text:
				caption === "" ? "User attached an image without a caption." : caption,
		},
		{
			type: "image",
			mimeType: detectTelegramImageMimeType(options?.filePath),
			data: imageData,
		},
	];
}

export async function buildTelegramPhotoUserInput(
	config: AppConfig,
	workspace: BackendProtocol,
	imageData: Uint8Array,
	options?: {
		caption?: string | null;
		filePath?: string;
	},
): Promise<TelegramUserInput> {
	if (!config.enableImageUnderstanding || config.minimaxApiKey === "") {
		return buildTelegramPhotoContent(imageData, options);
	}

	const { vfsPath } = await saveIncomingAttachment({
		backend: workspace,
		bytes: imageData,
		extension: extractIncomingExtension(options?.filePath),
	});

	return buildIncomingImagePromptText(vfsPath, options?.caption);
}

export async function fetchTelegramFileBytes(
	file: { file_path?: string },
	botToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ data: Uint8Array; filePath: string }> {
	const filePath = file.file_path;
	if (typeof filePath !== "string" || filePath === "") {
		throw new Error("Telegram did not return a downloadable file path.");
	}

	const response = await fetchImpl(
		`https://api.telegram.org/file/bot${botToken}/${filePath}`,
	);
	if (!response.ok) {
		throw new Error(
			`Telegram file download failed with status ${response.status}.`,
		);
	}

	return {
		data: new Uint8Array(await response.arrayBuffer()),
		filePath,
	};
}

export async function processTelegramFile(
	config: AppConfig,
	registry: CapabilityRegistry,
	session: TelegramAgentSession,
	bot: Bot,
	chatId: string,
	caller: Caller,
	store: PermissionsStore,
	webShare: ChannelRunOptions["webShare"],
	params: {
		metadata: FileMetadata;
		download: () => Promise<Uint8Array>;
		currentMessageDate?: Date;
	},
	helpers: ProcessTelegramFileHelpers = {},
): Promise<void> {
	const sendMessage = helpers.sendMessage ?? sendTelegramMessage;
	const queueTurn = helpers.queueTurn ?? handleTelegramQueuedTurn;
	log.info("processTelegramFile called", { metadata: params.metadata });
	const capability = registry.match(params.metadata);
	log.info("processTelegramFile matched capability", { name: capability?.name ?? "null" });
	const result = await registry.handle(params.metadata, params.download);
	log.info("processTelegramFile result", { ok: result.ok, userMessage: result.ok ? "N/A" : result.userMessage });
	if (!result.ok) {
		await sendMessage(bot, chatId, result.userMessage);
		return;
	}

	await queueTurn(
		session,
		bot,
		chatId,
		result.value.commandText ?? "",
		result.value.content as TelegramUserInput,
		caller,
		store,
		webShare,
		result.value.currentUserText,
		capability === null
			? undefined
			: {
					capabilityName: capability.name,
					config: buildAttachmentBudgetConfig(config),
					enableCompactionNotice: config.enableAttachmentCompactionNotice,
					callerId: caller.id,
				},
		params.currentMessageDate,
	);
}

// We need to import handleTelegramQueuedTurn from turn.ts but that creates a circular dependency.
// Instead, we'll use a late-binding approach where turn.ts provides the reference.
// Actually, the cleanest solution is to not import it here and let handlers.ts pass it via helpers.
// But the original code uses it directly. Let me check...

// Actually, looking at the original code, processTelegramFile calls handleTelegramQueuedTurn directly.
// And handleTelegramQueuedTurn is defined in turn.ts. So we need to import it.
// But turn.ts doesn't import from files.ts, so there's no circular dependency.

// Wait, I need to import handleTelegramQueuedTurn. But it's defined in turn.ts which hasn't been created yet.
// Let me use a different approach: define the queueTurn parameter with a default that will be set later.

// Actually, the simplest approach: import it from turn.ts. Since turn.ts doesn't import from files.ts,
// there's no circular dependency.

import { handleTelegramQueuedTurn } from "./turn";
