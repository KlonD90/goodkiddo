// Re-export types
export type {
	PendingApproval,
	TelegramAgentSession,
	TelegramTextContentBlock,
	TelegramImageContentBlock,
	TelegramUserInput,
	TelegramQueuedTurn,
	TelegramAttachmentBudget,
	ProcessTelegramFileHelpers,
	TelegramListState,
	TelegramMarkdownRenderEnv,
	MarkdownTableBlock,
	TrailingMarkdownTableContext,
	TelegramMarkdownChunkContext,
} from "./telegram/types";

// Re-export constants
export {
	TELEGRAM_MAX_MESSAGE_LENGTH,
	TELEGRAM_MAX_CAPTION_LENGTH,
	APPROVAL_TIMEOUT_MS,
	TELEGRAM_HTML_PARSE_MODE,
	TELEGRAM_TYPING_INTERVAL_MS,
	TELEGRAM_STREAM_PARAGRAPH_FLUSH_INTERVAL_MS,
	TELEGRAM_STREAM_CHUNK_MIN_LENGTH,
	TELEGRAM_STREAM_CHUNK_TARGET_LENGTH,
	TELEGRAM_STREAM_CHUNK_HARD_LENGTH,
	ATTACHMENT_COMPACTION_NOTICE,
	TELEGRAM_STREAM_DEFAULT_BOUNDARY_PATTERNS,
	TELEGRAM_STREAM_PARAGRAPH_BOUNDARY_PATTERNS,
	TELEGRAM_STREAM_OVERFLOW_BOUNDARY_PATTERNS,
	TELEGRAM_COMMANDS,
} from "./telegram/types";

// Re-export helpers
export { dateFromTelegramMessage, normalizeTelegramCommandText } from "./telegram/types";

// Re-export markdown
export {
	renderTelegramHtml,
	renderTelegramCaptionHtml,
	isSafeTelegramMarkdownChunk,
	scanTelegramMarkdownChunkContext,
	splitOversizedMarkdownTableSource,
	escapeTelegramHtml,
} from "./telegram/markdown";

// Re-export streaming
export {
	chunkTelegramMessage,
	chunkRenderedTelegramMessages,
	takeTelegramStreamChunks,
	takeTelegramParagraphStreamChunks,
	takeTelegramOverflowStreamChunks,
	mergeTelegramStreamText,
	findTelegramStreamBoundary,
} from "./telegram/streaming";

// Re-export outbound
export {
	TelegramOutboundChannel,
	sendTelegramMessage,
	sendTelegramTyping,
	startTelegramTypingLoop,
} from "./telegram/outbound";

// Re-export context
export {
	extractTelegramMessageContext,
	renderTelegramContextBlock,
} from "./telegram/context";
export type {
	TelegramMessageContext,
	TelegramMessageLike,
	TelegramReplyContext,
	TelegramForwardContext,
} from "./telegram/context";

// Re-export files
export {
	buildTelegramPhotoContent,
	fetchTelegramFileBytes,
	processTelegramFile,
} from "./telegram/files";

// Re-export session
export { ensureTelegramSession } from "./telegram/session";

// Re-export attachment
export {
	applyTelegramAttachmentBudget,
	buildAttachmentBudgetConfig,
} from "./telegram/attachment";

// Re-export turn
export {
	extractTelegramReplyFromAgentState,
	maybeHandleTelegramApprovalReply,
	handleTelegramQueuedTurn,
	extractTelegramCommandName,
	formatUnknownTelegramCommandReply,
	isTelegramStartCommand,
	maybeHandleTelegramStartCommand,
	renderTelegramWelcomeMessage,
	getTelegramCaller,
} from "./telegram/turn";

// Re-export handlers (telegramChannel)
export { telegramChannel } from "./telegram/handlers";
