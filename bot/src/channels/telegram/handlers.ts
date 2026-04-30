import { Bot } from "grammy";
import { createCapabilityRegistry } from "../../capabilities/registry";
import { startScheduler } from "../../capabilities/timers/scheduler";
import type { TimerRecord } from "../../capabilities/timers/store";
import { TimerStore } from "../../capabilities/timers/store";
import { VOICE_MIME_TYPE } from "../../capabilities/voice/constants";
import type { AppConfig } from "../../config";
import { createDb, detectDialect } from "../../db/index";
import { resolveLocale } from "../../i18n/locale";
import { createLogger } from "../../logger";
import type { Caller } from "../../permissions/types";
import { createStatusEmitter } from "../../tools/status_emitter";
import { fileDataToString } from "../../utils/filesystem";
import type { AppChannel, ChannelRunOptions } from "../types";
import {
	extractTelegramMessageContext,
	renderTelegramContextBlock,
} from "./context";
import {
	buildTelegramPhotoUserInput,
	fetchTelegramFileBytes,
	isImageMimeType,
	processTelegramFile,
} from "./files";
import { sendTelegramMessage, TelegramOutboundChannel } from "./outbound";
import { ensureTelegramSession } from "./session";
import {
	getTelegramCaller,
	handleTelegramControlInput,
	handleTelegramQueuedTurn,
	maybeHandleTelegramStartCommand,
} from "./turn";
import type { TelegramAgentSession } from "./types";
import {
	dateFromTelegramMessage,
	normalizeTelegramCommandText,
	TELEGRAM_COMMANDS,
} from "./types";

const log = createLogger("telegram");

async function syncTelegramCommands(bot: Bot): Promise<void> {
	await bot.api.setMyCommands([...TELEGRAM_COMMANDS]);
}

export const telegramChannel: AppChannel = {
	entrypoint: "telegram",
	async run(config: AppConfig, options?: ChannelRunOptions): Promise<void> {
		const webShare = options?.webShare;
		const db = options?.db ?? createDb(config.databaseUrl);
		const dialect = options?.dialect ?? detectDialect(config.databaseUrl);
		const store = new PermissionsStore({ db, dialect });
		const timerStore = options?.timerStore ?? new TimerStore({ db, dialect });
		const sessions = new Map<string, TelegramAgentSession>();
		const bot = new Bot(config.telegramBotToken);
		const outbound = new TelegramOutboundChannel(bot, (callerId) => {
			const telegramPrefix = "telegram:";
			if (!callerId.startsWith(telegramPrefix)) return null;
			const chatId = callerId.slice(telegramPrefix.length);
			if (!sessions.has(chatId)) return null;
			return chatId;
		});
		const statusEmitter = createStatusEmitter(outbound);
		const capabilityRegistry =
			options?.capabilityRegistry ??
			createCapabilityRegistry(config, {
				voice: options?.transcriber
					? { transcriber: options.transcriber }
					: undefined,
				pdf: options?.pdfExtractor
					? { extractor: options.pdfExtractor }
					: undefined,
				spreadsheet: options?.spreadsheetParser
					? { parser: options.spreadsheetParser }
					: undefined,
			});

		const resolveContext = async (ctx: {
			chat: { id: number };
			from?: { language_code?: string };
		}): Promise<{
			session: TelegramAgentSession;
			caller: Caller;
			chatIdString: string;
			isNew: boolean;
		} | null> => {
			const chatIdString = String(ctx.chat.id);
			const result = await getTelegramCaller(store, chatIdString);
			if (!result) {
				await sendTelegramMessage(bot, chatIdString, config.blockedUserMessage);
				return null;
			}
			const { caller, isNew } = result;
			const locale = resolveLocale(
				ctx.from?.language_code,
				config.defaultStatusLocale as "en" | "ru" | "es",
			);
			const session = await ensureTelegramSession(
				chatIdString,
				caller,
				config,
				db,
				dialect,
				store,
				bot,
				sessions,
				outbound,
				webShare,
				timerStore,
				statusEmitter,
				locale,
			);
			session.locale = locale;
			return { session, caller, chatIdString, isNew };
		};

		await syncTelegramCommands(bot);

		log.info("starting bot polling loop");
		if (config.telegramAllowedChatId !== "") {
			log.warn(
				"TELEGRAM_BOT_ALLOWED_CHAT_ID is deprecated; access is now governed by harness_users. Ignoring.",
			);
		}

		bot.on("callback_query:data", async (ctx) => {
			const chatId = ctx.chat?.id;
			const data = ctx.callbackQuery.data;
			if (chatId === undefined || data === "") {
				try {
					await ctx.answerCallbackQuery();
				} catch (err) {
					log.debug("answerCallbackQuery failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
				return;
			}

			const chatIdString = String(chatId);
			const session = sessions.get(chatIdString);
			const separator = data.indexOf(":");
			const outcome = separator === -1 ? data : data.slice(0, separator);
			const promptId = separator === -1 ? "" : data.slice(separator + 1);
			const pending = session?.pendingApprovals.get(promptId);
			if (
				pending &&
				(outcome === "approve-once" ||
					outcome === "approve-always" ||
					outcome === "deny-once" ||
					outcome === "deny-always")
			) {
				log.info("approval decided", {
					chatId: chatIdString,
					promptId,
					outcome,
					toolName: pending.request.toolName,
				});
				session?.pendingApprovals.delete(promptId);
				await pending.resolve(outcome);
			} else {
				log.debug("callback query ignored", {
					chatId: chatIdString,
					outcome,
					promptId,
					hasPending: Boolean(pending),
				});
			}

			try {
				await ctx.answerCallbackQuery();
			} catch (err) {
				log.debug("answerCallbackQuery failed", {
					chatId: chatIdString,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		});

		const downloadTelegramFile = (
			getFile: () => Promise<{ file_path?: string }>,
		): (() => Promise<Uint8Array>) => {
			return async () => {
				const file = await getFile();
				const { data } = await fetchTelegramFileBytes(
					file,
					config.telegramBotToken,
				);
				return data;
			};
		};

		bot.on("message:text", async (ctx) => {
			const text = normalizeTelegramCommandText(ctx.message.text);
			const msgCtx = extractTelegramMessageContext(ctx.message);
			const contextBlock = renderTelegramContextBlock(msgCtx);
			const isForwarded = msgCtx.forward !== undefined;

			// Skip empty non-forwarded messages (existing behavior)
			if (text === "" && !isForwarded) return;

			const resolved = await resolveContext(ctx);
			if (!resolved) return;

			// /start is always direct — never from a forwarded message
			if (!isForwarded && await maybeHandleTelegramStartCommand(bot, resolved.chatIdString, text, resolved.isNew)) {
				return;
			}

			log.info("text message received", {
				chatId: resolved.chatIdString,
				callerId: resolved.caller.id,
				length: text.length,
				isForwarded,
				hasReplyContext: msgCtx.reply !== undefined,
			});

			// commandText drives session/permission command detection — only from
			// direct (non-forwarded) user text so forwarded slash commands never fire.
			const commandText = isForwarded ? "" : text;

			// Agent-visible content: forwarded text lives inside the context block;
			// replied-to content is a preamble before the user's current text.
			const agentContent = isForwarded
				? contextBlock
				: contextBlock
					? `${contextBlock}\n\n${text}`
					: text;

			await handleTelegramQueuedTurn(
				resolved.session,
				bot,
				resolved.chatIdString,
				commandText,
				agentContent,
				resolved.caller,
				store,
				webShare,
				// currentUserText for task-check: direct text only, never forwarded content
				isForwarded ? undefined : text,
				undefined,
				dateFromTelegramMessage(ctx.message.date),
			);
		});

		bot.on("message:photo", async (ctx) => {
			const resolved = await resolveContext(ctx);
			if (!resolved) return;
			const caption = normalizeTelegramCommandText(ctx.message.caption);
			const msgCtx = extractTelegramMessageContext(ctx.message);
			const contextBlock = renderTelegramContextBlock(msgCtx);
			const isForwarded = msgCtx.forward !== undefined;

			log.info("photo message received", {
				chatId: resolved.chatIdString,
				callerId: resolved.caller.id,
				hasCaption: caption !== "",
				isForwarded,
				hasReplyContext: msgCtx.reply !== undefined,
			});

			try {
				// Command detection runs only on direct (non-forwarded) caption text
				if (
					!isForwarded &&
					await handleTelegramControlInput(
						resolved.session,
						bot,
						resolved.chatIdString,
						caption,
						resolved.caller,
						store,
						webShare,
					)
				) {
					return;
				}

				const file = await ctx.getFile();
				const downloaded = await fetchTelegramFileBytes(
					file,
					config.telegramBotToken,
				);
				const content = await buildTelegramPhotoUserInput(
					config,
					resolved.session.workspace,
					downloaded.data,
					{
						caption,
						filePath: downloaded.filePath,
						contextPrefix: contextBlock || undefined,
					},
				);

				await handleTelegramQueuedTurn(
					resolved.session,
					bot,
					resolved.chatIdString,
					"",
					content,
					resolved.caller,
					store,
					webShare,
					undefined,
					undefined,
					dateFromTelegramMessage(ctx.message.date),
				);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Unknown Telegram photo handling error";
				log.error("photo handler failed", {
					chatId: resolved.chatIdString,
					callerId: resolved.caller.id,
					error: message,
				});
				await sendTelegramMessage(
					bot,
					resolved.chatIdString,
					`Request failed: ${message}`,
				);
			}
		});

		bot.on("message:voice", async (ctx) => {
			const resolved = await resolveContext(ctx);
			if (!resolved) return;
			const caption = normalizeTelegramCommandText(ctx.message.caption);
			const msgCtx = extractTelegramMessageContext(ctx.message);
			const contextBlock = renderTelegramContextBlock(msgCtx);
			const isForwarded = msgCtx.forward !== undefined;

			log.info("voice message received", {
				chatId: resolved.chatIdString,
				callerId: resolved.caller.id,
				byteSize: ctx.message.voice.file_size,
				hasReplyContext: msgCtx.reply !== undefined,
			});

			await processTelegramFile(
				config,
				capabilityRegistry,
				resolved.session,
				bot,
				resolved.chatIdString,
				resolved.caller,
				store,
				webShare,
				{
					metadata: {
						mimeType: VOICE_MIME_TYPE,
						byteSize: ctx.message.voice.file_size,
						filename: "voice.ogg",
						caption,
					},
					download: downloadTelegramFile(() => ctx.getFile()),
					currentMessageDate: dateFromTelegramMessage(ctx.message.date),
					contextPrefix: contextBlock || undefined,
					contextIsForwarded: isForwarded,
				},
			);
		});

		bot.on("message:document", async (ctx) => {
			const resolved = await resolveContext(ctx);
			if (!resolved) return;

			const document = ctx.message.document;
			const msgCtx = extractTelegramMessageContext(ctx.message);
			const contextBlock = renderTelegramContextBlock(msgCtx);

			const docCaption = normalizeTelegramCommandText(document.file_name ?? "");
			const isForwarded = msgCtx.forward !== undefined;

			log.info("document message received", {
				chatId: resolved.chatIdString,
				callerId: resolved.caller.id,
				filename: document.file_name,
				mimeType: document.mime_type,
				byteSize: document.file_size,
				hasReplyContext: msgCtx.reply !== undefined,
				isForwarded,
			});

			if (isImageMimeType(document.mime_type)) {
				try {
					if (
						!isForwarded &&
						await handleTelegramControlInput(
							resolved.session,
							bot,
							resolved.chatIdString,
							docCaption,
							resolved.caller,
							store,
							webShare,
						)
					) {
						return;
					}

					const file = await ctx.getFile();
					const downloaded = await fetchTelegramFileBytes(
						file,
						config.telegramBotToken,
					);
					const content = await buildTelegramPhotoUserInput(
						config,
						resolved.session.workspace,
						downloaded.data,
						{
							caption: docCaption,
							filePath: downloaded.filePath,
							contextPrefix: contextBlock || undefined,
						},
					);

					await handleTelegramQueuedTurn(
						resolved.session,
						bot,
						resolved.chatIdString,
						"",
						content,
						resolved.caller,
						store,
						webShare,
						undefined,
						undefined,
						dateFromTelegramMessage(ctx.message.date),
					);
				} catch (error) {
					const message =
						error instanceof Error
							? error.message
							: "Unknown Telegram document handling error";
					log.error("document handler failed", {
						chatId: resolved.chatIdString,
						callerId: resolved.caller.id,
						error: message,
					});
					await sendTelegramMessage(
						bot,
						resolved.chatIdString,
						`Request failed: ${message}`,
					);
				}
			} else {
				await processTelegramFile(
					config,
					capabilityRegistry,
					resolved.session,
					bot,
					resolved.chatIdString,
					resolved.caller,
					store,
					webShare,
					{
						metadata: {
							mimeType: document.mime_type,
							filename: document.file_name,
							byteSize: document.file_size,
						},
						download: downloadTelegramFile(() => ctx.getFile()),
						currentMessageDate: dateFromTelegramMessage(ctx.message.date),
						contextPrefix: contextBlock || undefined,
						contextIsForwarded: isForwarded,
					},
				);
			}
		});

		bot.catch(async (error) => {
			const err = error.error;
			log.error("bot error", {
				error: err instanceof Error ? err.message : String(err),
				updateId: error.ctx?.update?.update_id,
			});
		});

		const rawChatIdFromTimer = (timer: TimerRecord): string =>
			timer.chatId.replace(/^telegram:/, "");

		const ensureTimerSession = async (
			timer: TimerRecord,
		): Promise<TelegramAgentSession> => {
			const chatId = rawChatIdFromTimer(timer);
			const existing = sessions.get(chatId);
			if (existing) return existing;

			const callerResult = await getTelegramCaller(store, chatId);
			if (!callerResult || callerResult.caller.id !== timer.userId) {
				throw new Error(
					`Timer user ${timer.userId} is not an active Telegram user.`,
				);
			}
			return ensureTelegramSession(
				chatId,
				callerResult.caller,
				config,
				db,
				dialect,
				store,
				bot,
				sessions,
				outbound,
				webShare,
				timerStore,
				statusEmitter,
				config.defaultStatusLocale as "en" | "ru" | "es",
			);
		};

		const readMdFile = async (
			timer: TimerRecord,
			path: string,
		): Promise<string> => {
			const session = await ensureTimerSession(timer);
			const data = await session.workspace.readRaw(path);
			return fileDataToString(data);
		};

		const onTick = async (
			timer: TimerRecord,
			promptText: string,
		): Promise<void> => {
			const session = await ensureTimerSession(timer);

			try {
				session.currentUserText = promptText;
				session.currentTurnContext = {
					now: new Date(),
					source: "scheduler",
				};
				await session.refreshAgent();
				const invokeMessages = buildInvokeMessages(session, {
					role: "user",
					content: promptText,
				});

				const stream = await session.agent.stream(
					{ messages: invokeMessages },
					{
						configurable: { thread_id: session.threadId },
						streamMode: "messages",
						recursionLimit: session.recursionLimit,
					},
				);
				let fullText = "";
				const streamIterator = stream[Symbol.asyncIterator]();
				for await (const chunk of streamIterator) {
					if (!Array.isArray(chunk) || chunk.length < 1) continue;
					const message = chunk[0];
					const text =
						"text" in message && typeof message.text === "string"
							? message.text
							: "content" in message
								? extractTextFromContent(message.content)
								: "";
					fullText += text;
				}
				if (fullText.trim() !== "") {
					const chatId = rawChatIdFromTimer(timer);
					await sendTelegramMessage(bot, chatId, fullText);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log.error("timer onTick failed", {
					timerId: timer.id,
					path: timer.mdFilePath,
					error: message,
				});
				throw err;
			} finally {
				session.currentUserText = undefined;
				session.currentTurnContext = undefined;
			}
		};

		const notifyUser = async (
			userId: string,
			message: string,
		): Promise<void> => {
			const chatId = userId.replace(/^telegram:/, "");
			await sendTelegramMessage(bot, chatId, message);
		};

		let schedulerStop: (() => void) | undefined;
		const timerScheduler = options?.timerScheduler ?? {
			start: startScheduler,
		};
		if (config.appEntrypoint === "telegram") {
			schedulerStop = timerScheduler.start(timerStore, {
				intervalMs: 60_000,
				readMdFile,
				onTick,
				notifyUser,
			}).stop;
		}

		const stopScheduler = () => {
			if (schedulerStop) {
				schedulerStop();
				schedulerStop = undefined;
			}
		};

		process.on("SIGINT", stopScheduler);
		process.on("SIGTERM", stopScheduler);

		await bot.start({
			onStart: (botInfo) => {
				log.info("bot connected", { username: botInfo.username });
			},
		});

		if (!options?.db) {
			await db.close();
		}
	},
};

import { PermissionsStore } from "../../permissions/store";
import { buildInvokeMessages, extractTextFromContent } from "../shared";
