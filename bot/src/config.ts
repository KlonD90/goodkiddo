import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { clearScreenDown, cursorTo, emitKeypressEvents } from "node:readline";
import {
	type AppEntrypoint,
	checkAiType,
	checkAppEntrypoint,
	checkUsingMode,
	SUPPORTED_AI_TYPES,
	SUPPORTED_APP_ENTRYPOINTS,
	type SupportedAiTypes,
	type UsingMode,
} from "./types";
import { isValidTimezone } from "./utils/timezone";

export type AppConfig = {
	aiApiKey: string;
	aiBaseUrl: string;
	aiType: SupportedAiTypes;
	aiModelName: string;
	aiTemperature: number;
	aiSubAgentTemperature: number;
	appEntrypoint: AppEntrypoint;
	telegramBotToken: string;
	telegramAllowedChatId: string;
	usingMode: UsingMode;
	blockedUserMessage: string;
	maxContextWindowTokens: number;
	contextReserveSummaryTokens: number;
	contextReserveRecentTurnTokens: number;
	contextReserveNextTurnTokens: number;
	permissionsMode: "enforce" | "disabled";
	databaseUrl: string;
	enableExecute: boolean;
	enableVoiceMessages: boolean;
	enablePdfDocuments: boolean;
	enableSpreadsheets: boolean;
	enableImageUnderstanding: boolean;
	enableToolStatus: boolean;
	enableAttachmentCompactionNotice: boolean;
	enableBrowserOnParent: boolean;
	enableTabular: boolean;
	defaultStatusLocale: string;
	transcriptionProvider: TranscriptionProvider;
	transcriptionApiKey: string;
	transcriptionBaseUrl: string;
	minimaxApiKey: string;
	minimaxApiHost: string;
	webHost: string;
	webPort: number;
	webPublicBaseUrl: string;
	timezone: string;
	recursionLimit: number;
};

export type TranscriptionProvider = "openai" | "openrouter";

const DEFAULT_BLOCKED_USER_MESSAGE =
	"Access not configured. Contact the admin.";
const DEFAULT_MAX_CONTEXT_WINDOW_TOKENS = 150000;
const DEFAULT_CONTEXT_RESERVE_SUMMARY_TOKENS = 2000;
const DEFAULT_CONTEXT_RESERVE_RECENT_TURN_TOKENS = 2000;
const DEFAULT_CONTEXT_RESERVE_NEXT_TURN_TOKENS = 2000;
const DEFAULT_DATABASE_URL = "sqlite://./state.db";
const DEFAULT_AI_TEMPERATURE = 1.0;
const DEFAULT_AI_SUB_AGENT_TEMPERATURE = 0.4;
const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 8083;
const DEFAULT_WEB_PUBLIC_BASE_URL = `http://localhost:${DEFAULT_WEB_PORT}`;
const DEFAULT_ENABLE_VOICE_MESSAGES = true;
const DEFAULT_ENABLE_PDF_DOCUMENTS = true;
const DEFAULT_ENABLE_SPREADSHEETS = true;
const DEFAULT_ENABLE_IMAGE_UNDERSTANDING = false;
const DEFAULT_ENABLE_TOOL_STATUS = true;
const DEFAULT_ENABLE_ATTACHMENT_COMPACTION_NOTICE = true;
const DEFAULT_ENABLE_BROWSER_ON_PARENT = false;
const DEFAULT_ENABLE_TABULAR = true;
const DEFAULT_STATUS_LOCALE = "en";
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_MINIMAX_API_HOST = "https://api.minimax.io";
const DEFAULT_RECURSION_LIMIT = 60;
const SUPPORTED_TRANSCRIPTION_PROVIDERS: readonly TranscriptionProvider[] = [
	"openai",
	"openrouter",
];

type ConfigIssueField =
	| "AI_API_KEY"
	| "AI_BASE_URL"
	| "AI_MODEL_NAME"
	| "AI_RECURSION_LIMIT"
	| "AI_SUB_AGENT_TEMPERATURE"
	| "AI_TEMPERATURE"
	| "AI_TYPE"
	| "APP_ENTRYPOINT"
	| "BLOCKED_USER_MESSAGE"
	| "CONTEXT_RESERVE_NEXT_TURN_TOKENS"
	| "CONTEXT_RESERVE_RECENT_TURN_TOKENS"
	| "CONTEXT_RESERVE_SUMMARY_TOKENS"
	| "ENABLE_EXECUTE"
	| "ENABLE_IMAGE_UNDERSTANDING"
	| "ENABLE_PDF_DOCUMENTS"
	| "ENABLE_SPREADSHEETS"
	| "ENABLE_ATTACHMENT_COMPACTION_NOTICE"
	| "ENABLE_BROWSER_ON_PARENT"
	| "ENABLE_TABULAR"
	| "ENABLE_TOOL_STATUS"
	| "ENABLE_VOICE_MESSAGES"
	| "MAX_CONTEXT_WINDOW_TOKENS"
	| "MINIMAX_API_HOST"
	| "MINIMAX_API_KEY"
	| "PERMISSIONS_MODE"
	| "DATABASE_URL"
	| "DEFAULT_STATUS_LOCALE"
	| "TELEGRAM_BOT_ALLOWED_CHAT_ID"
	| "TELEGRAM_BOT_TOKEN"
	| "TIMEZONE"
	| "TRANSCRIPTION_API_KEY"
	| "TRANSCRIPTION_BASE_URL"
	| "TRANSCRIPTION_PROVIDER"
	| "USING_MODE"
	| "WEB_HOST"
	| "WEB_PORT"
	| "WEB_PUBLIC_BASE_URL";

type ConfigIssue = {
	field: ConfigIssueField;
	reason: string;
};

type WizardPrompt = (message: string) => string | null | undefined;
type WizardOption<TValue extends string> = {
	label: string;
	value: TValue;
};
type WizardSelect = <TValue extends string>(
	title: string,
	description: string,
	options: readonly WizardOption<TValue>[],
) => Promise<TValue>;
type ResolveConfigOptions = {
	promptUser?: WizardPrompt;
	selectValue?: WizardSelect;
	envFilePath?: string;
};
type PersistedEnvValues = Partial<Record<ConfigIssueField, string>>;

const SUPPORTED_USING_MODES: readonly UsingMode[] = ["single", "multi"];
const DEFAULT_AI_TYPE: SupportedAiTypes = "anthropic";
const DEFAULT_USING_MODE: UsingMode = "single";
const DEFAULT_APP_ENTRYPOINT: AppEntrypoint = "cli";
const DEFAULT_ENV_FILE_PATH = resolvePath(process.cwd(), ".env");
const PERSISTED_ENV_KEYS = [
	"AI_API_KEY",
	"AI_BASE_URL",
	"AI_MODEL_NAME",
	"AI_RECURSION_LIMIT",
	"AI_SUB_AGENT_TEMPERATURE",
	"AI_TEMPERATURE",
	"AI_TYPE",
	"APP_ENTRYPOINT",
	"BLOCKED_USER_MESSAGE",
	"CONTEXT_RESERVE_NEXT_TURN_TOKENS",
	"CONTEXT_RESERVE_RECENT_TURN_TOKENS",
	"CONTEXT_RESERVE_SUMMARY_TOKENS",
	"ENABLE_EXECUTE",
	"ENABLE_IMAGE_UNDERSTANDING",
	"ENABLE_PDF_DOCUMENTS",
	"ENABLE_SPREADSHEETS",
	"ENABLE_ATTACHMENT_COMPACTION_NOTICE",
	"ENABLE_BROWSER_ON_PARENT",
	"ENABLE_TABULAR",
	"ENABLE_TOOL_STATUS",
	"ENABLE_VOICE_MESSAGES",
	"MAX_CONTEXT_WINDOW_TOKENS",
	"MINIMAX_API_HOST",
	"MINIMAX_API_KEY",
	"PERMISSIONS_MODE",
	"DATABASE_URL",
	"DEFAULT_STATUS_LOCALE",
	"TELEGRAM_BOT_ALLOWED_CHAT_ID",
	"TELEGRAM_BOT_TOKEN",
	"TIMEZONE",
	"TRANSCRIPTION_API_KEY",
	"TRANSCRIPTION_BASE_URL",
	"TRANSCRIPTION_PROVIDER",
	"USING_MODE",
	"WEB_HOST",
	"WEB_PORT",
	"WEB_PUBLIC_BASE_URL",
] as const;
const PERSISTED_ENV_ASSIGNMENT_REGEX = new RegExp(
	`^(${PERSISTED_ENV_KEYS.join("|")})=(.*)$`,
	"u",
);
const PERSISTED_ENV_LINE_REGEX = new RegExp(
	`^(${PERSISTED_ENV_KEYS.join("|")})=`,
	"u",
);

const getEnv = (
	name: ConfigIssueField,
	persistedValues: PersistedEnvValues = {},
): string => {
	const processValue = normalize(process.env[name] as string | undefined);
	if (processValue !== "") {
		return processValue;
	}

	return normalize(persistedValues[name]);
};
const normalize = (value: string | null | undefined): string =>
	(value ?? "").trim();
const parsePositiveInteger = (rawValue: string): number => {
	if (!/^\d+$/u.test(rawValue)) {
		return Number.NaN;
	}

	const value = Number.parseInt(rawValue, 10);
	return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN;
};
const parseTemperature = (rawValue: string): number => {
	if (rawValue === "") return Number.NaN;
	const value = Number(rawValue);
	return Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: Number.NaN;
};
const readPositiveIntegerEnv = (
	name: ConfigIssueField,
	persistedValues: PersistedEnvValues,
	fallback: number,
): number => {
	const rawValue = getEnv(name, persistedValues);
	return rawValue === "" ? fallback : parsePositiveInteger(rawValue);
};
const readTemperatureEnv = (
	name: ConfigIssueField,
	persistedValues: PersistedEnvValues,
	fallback: number,
): number => {
	const rawValue = getEnv(name, persistedValues);
	return rawValue === "" ? fallback : parseTemperature(rawValue);
};

const defaultPrompt: WizardPrompt = (message) => prompt(message);

const APP_ENTRYPOINT_OPTIONS: readonly WizardOption<AppEntrypoint>[] =
	SUPPORTED_APP_ENTRYPOINTS.map((value) => ({
		value,
		label: value === "cli" ? "CLI runner" : "Telegram bot polling runner",
	}));

const AI_TYPE_OPTIONS: readonly WizardOption<SupportedAiTypes>[] =
	SUPPORTED_AI_TYPES.map((value) => ({
		value,
		label: `${value} provider`,
	}));

const USING_MODE_OPTIONS: readonly WizardOption<UsingMode>[] =
	SUPPORTED_USING_MODES.map((value) => ({
		value,
		label:
			value === "single"
				? "single: run one agent"
				: "multi: reserve multi-agent mode",
	}));

const checkTranscriptionProvider = (
	value: string,
): value is TranscriptionProvider =>
	SUPPORTED_TRANSCRIPTION_PROVIDERS.includes(value as TranscriptionProvider);

const defaultTranscriptionProviderForAiType = (
	aiType: SupportedAiTypes | undefined,
): TranscriptionProvider => (aiType === "openrouter" ? "openrouter" : "openai");

const isAiApiKeyRequired = (
	aiType: SupportedAiTypes | undefined,
	aiBaseUrl: string | undefined,
): boolean => aiType === "openrouter" || (aiBaseUrl ?? "") === "";

export const canReusePrimaryAiCredentialsForTranscription = (
	aiType: SupportedAiTypes | undefined,
	transcriptionProvider: TranscriptionProvider | undefined,
): boolean =>
	transcriptionProvider !== undefined &&
	(aiType === "openai" || aiType === "openrouter") &&
	aiType === transcriptionProvider;

export const readConfigFromEnv = (
	persistedValues: PersistedEnvValues = {},
): Partial<AppConfig> => {
	const aiTypeValue = getEnv("AI_TYPE", persistedValues);
	const usingModeValue = getEnv("USING_MODE", persistedValues);
	const entrypointValue = getEnv("APP_ENTRYPOINT", persistedValues);

	const permissionsModeRaw = getEnv("PERMISSIONS_MODE", persistedValues);
	const permissionsMode =
		permissionsModeRaw === "disabled" ? "disabled" : "enforce";

	const enableExecuteRaw = getEnv("ENABLE_EXECUTE", persistedValues);
	const enableExecute = enableExecuteRaw !== "false";

	const enableVoiceMessagesRaw = getEnv(
		"ENABLE_VOICE_MESSAGES",
		persistedValues,
	);
	const enableVoiceMessages =
		enableVoiceMessagesRaw === ""
			? DEFAULT_ENABLE_VOICE_MESSAGES
			: enableVoiceMessagesRaw !== "false";

	const enablePdfDocumentsRaw = getEnv("ENABLE_PDF_DOCUMENTS", persistedValues);
	const enablePdfDocuments =
		enablePdfDocumentsRaw === ""
			? DEFAULT_ENABLE_PDF_DOCUMENTS
			: enablePdfDocumentsRaw !== "false";

	const enableSpreadsheetsRaw = getEnv("ENABLE_SPREADSHEETS", persistedValues);
	const enableSpreadsheets =
		enableSpreadsheetsRaw === ""
			? DEFAULT_ENABLE_SPREADSHEETS
			: enableSpreadsheetsRaw !== "false";

	const enableImageUnderstandingRaw = getEnv(
		"ENABLE_IMAGE_UNDERSTANDING",
		persistedValues,
	);
	const enableImageUnderstanding =
		enableImageUnderstandingRaw === ""
			? DEFAULT_ENABLE_IMAGE_UNDERSTANDING
			: enableImageUnderstandingRaw === "true";

	const minimaxApiKey = getEnv("MINIMAX_API_KEY", persistedValues);
	const minimaxApiHostRaw = getEnv("MINIMAX_API_HOST", persistedValues);
	const minimaxApiHost =
		minimaxApiHostRaw === "" ? DEFAULT_MINIMAX_API_HOST : minimaxApiHostRaw;

	const enableToolStatusRaw = getEnv("ENABLE_TOOL_STATUS", persistedValues);
	const enableToolStatus =
		enableToolStatusRaw === ""
			? DEFAULT_ENABLE_TOOL_STATUS
			: enableToolStatusRaw !== "false";

	const enableAttachmentCompactionNoticeRaw = getEnv(
		"ENABLE_ATTACHMENT_COMPACTION_NOTICE",
		persistedValues,
	);
	const enableAttachmentCompactionNotice =
		enableAttachmentCompactionNoticeRaw === ""
			? DEFAULT_ENABLE_ATTACHMENT_COMPACTION_NOTICE
			: enableAttachmentCompactionNoticeRaw !== "false";

	const enableBrowserOnParentRaw = getEnv(
		"ENABLE_BROWSER_ON_PARENT",
		persistedValues,
	);
	const enableBrowserOnParent =
		enableBrowserOnParentRaw === ""
			? DEFAULT_ENABLE_BROWSER_ON_PARENT
			: enableBrowserOnParentRaw === "true";

	const enableTabularRaw = getEnv("ENABLE_TABULAR", persistedValues);
	const enableTabular =
		enableTabularRaw === "" ? DEFAULT_ENABLE_TABULAR : enableTabularRaw !== "false";

	const defaultStatusLocaleRaw = getEnv(
		"DEFAULT_STATUS_LOCALE",
		persistedValues,
	);
	const defaultStatusLocale =
		defaultStatusLocaleRaw !== ""
			? defaultStatusLocaleRaw
			: DEFAULT_STATUS_LOCALE;

	const aiType = checkAiType(aiTypeValue) ? aiTypeValue : undefined;
	const transcriptionProviderRaw = getEnv(
		"TRANSCRIPTION_PROVIDER",
		persistedValues,
	);
	const transcriptionProvider =
		transcriptionProviderRaw === ""
			? defaultTranscriptionProviderForAiType(aiType)
			: checkTranscriptionProvider(transcriptionProviderRaw)
				? transcriptionProviderRaw
				: undefined;
	const transcriptionApiKeyRaw = getEnv(
		"TRANSCRIPTION_API_KEY",
		persistedValues,
	);
	const transcriptionApiKey =
		transcriptionApiKeyRaw !== ""
			? transcriptionApiKeyRaw
			: canReusePrimaryAiCredentialsForTranscription(
						aiType,
						transcriptionProvider,
					)
				? getEnv("AI_API_KEY", persistedValues)
				: "";
	const transcriptionBaseUrl = getEnv(
		"TRANSCRIPTION_BASE_URL",
		persistedValues,
	);

	const webHostRaw = getEnv("WEB_HOST", persistedValues);
	const webPortRaw = getEnv("WEB_PORT", persistedValues);
	const webPort =
		webPortRaw === "" ? DEFAULT_WEB_PORT : Number.parseInt(webPortRaw, 10);
	const webPublicBaseUrlRaw = getEnv("WEB_PUBLIC_BASE_URL", persistedValues);
	const maxContextWindowTokens = readPositiveIntegerEnv(
		"MAX_CONTEXT_WINDOW_TOKENS",
		persistedValues,
		DEFAULT_MAX_CONTEXT_WINDOW_TOKENS,
	);
	const contextReserveSummaryTokens = readPositiveIntegerEnv(
		"CONTEXT_RESERVE_SUMMARY_TOKENS",
		persistedValues,
		DEFAULT_CONTEXT_RESERVE_SUMMARY_TOKENS,
	);
	const contextReserveRecentTurnTokens = readPositiveIntegerEnv(
		"CONTEXT_RESERVE_RECENT_TURN_TOKENS",
		persistedValues,
		DEFAULT_CONTEXT_RESERVE_RECENT_TURN_TOKENS,
	);
	const contextReserveNextTurnTokens = readPositiveIntegerEnv(
		"CONTEXT_RESERVE_NEXT_TURN_TOKENS",
		persistedValues,
		DEFAULT_CONTEXT_RESERVE_NEXT_TURN_TOKENS,
	);
	const recursionLimit = readPositiveIntegerEnv(
		"AI_RECURSION_LIMIT",
		persistedValues,
		DEFAULT_RECURSION_LIMIT,
	);
	const aiTemperature = readTemperatureEnv(
		"AI_TEMPERATURE",
		persistedValues,
		DEFAULT_AI_TEMPERATURE,
	);
	const aiSubAgentTemperature = readTemperatureEnv(
		"AI_SUB_AGENT_TEMPERATURE",
		persistedValues,
		DEFAULT_AI_SUB_AGENT_TEMPERATURE,
	);

	return {
		aiApiKey: getEnv("AI_API_KEY", persistedValues),
		aiBaseUrl: getEnv("AI_BASE_URL", persistedValues),
		aiModelName: getEnv("AI_MODEL_NAME", persistedValues),
		aiTemperature,
		aiSubAgentTemperature,
		appEntrypoint: checkAppEntrypoint(entrypointValue)
			? entrypointValue
			: undefined,
		aiType,
		telegramAllowedChatId: getEnv(
			"TELEGRAM_BOT_ALLOWED_CHAT_ID",
			persistedValues,
		),
		telegramBotToken: getEnv("TELEGRAM_BOT_TOKEN", persistedValues),
		usingMode: checkUsingMode(usingModeValue) ? usingModeValue : undefined,
		blockedUserMessage:
			getEnv("BLOCKED_USER_MESSAGE", persistedValues) ||
			DEFAULT_BLOCKED_USER_MESSAGE,
		maxContextWindowTokens,
		contextReserveSummaryTokens,
		contextReserveRecentTurnTokens,
		contextReserveNextTurnTokens,
		permissionsMode,
		databaseUrl:
			getEnv("DATABASE_URL", persistedValues) || DEFAULT_DATABASE_URL,
		enableExecute,
		enableVoiceMessages,
		enablePdfDocuments,
		enableSpreadsheets,
		enableImageUnderstanding,
		enableToolStatus,
		enableAttachmentCompactionNotice,
		enableBrowserOnParent,
		enableTabular,
		defaultStatusLocale,
		transcriptionProvider,
		transcriptionApiKey,
		transcriptionBaseUrl,
		minimaxApiKey,
		minimaxApiHost,
		webHost: webHostRaw || DEFAULT_WEB_HOST,
		webPort: Number.isFinite(webPort) ? webPort : DEFAULT_WEB_PORT,
		webPublicBaseUrl: webPublicBaseUrlRaw || DEFAULT_WEB_PUBLIC_BASE_URL,
		timezone: getEnv("TIMEZONE", persistedValues) || DEFAULT_TIMEZONE,
		recursionLimit,
	};
};

export const findConfigIssues = (
	config: Partial<AppConfig>,
	persistedValues: PersistedEnvValues = {},
): ConfigIssue[] => {
	const issues: ConfigIssue[] = [];
	const rawAiType = getEnv("AI_TYPE", persistedValues);
	const rawUsingMode = getEnv("USING_MODE", persistedValues);
	const rawEntrypoint = getEnv("APP_ENTRYPOINT", persistedValues);
	const rawTranscriptionProvider = getEnv(
		"TRANSCRIPTION_PROVIDER",
		persistedValues,
	);

	if (rawAiType !== "" && !checkAiType(rawAiType)) {
		issues.push({
			field: "AI_TYPE",
			reason: `Invalid AI_TYPE "${rawAiType}". Supported values: ${SUPPORTED_AI_TYPES.join(", ")}`,
		});
	}

	if (rawUsingMode !== "" && !checkUsingMode(rawUsingMode)) {
		issues.push({
			field: "USING_MODE",
			reason: `Invalid USING_MODE "${rawUsingMode}". Supported values: ${SUPPORTED_USING_MODES.join(", ")}`,
		});
	}

	if (rawEntrypoint !== "" && !checkAppEntrypoint(rawEntrypoint)) {
		issues.push({
			field: "APP_ENTRYPOINT",
			reason: `Invalid APP_ENTRYPOINT "${rawEntrypoint}". Supported values: ${SUPPORTED_APP_ENTRYPOINTS.join(", ")}`,
		});
	}

	if (
		rawTranscriptionProvider !== "" &&
		!checkTranscriptionProvider(rawTranscriptionProvider)
	) {
		issues.push({
			field: "TRANSCRIPTION_PROVIDER",
			reason: `Invalid TRANSCRIPTION_PROVIDER "${rawTranscriptionProvider}". Supported values: ${SUPPORTED_TRANSCRIPTION_PROVIDERS.join(", ")}`,
		});
	}

	if (config.aiModelName === undefined || config.aiModelName === "") {
		issues.push({
			field: "AI_MODEL_NAME",
			reason: "AI_MODEL_NAME is missing.",
		});
	}

	if (
		isAiApiKeyRequired(config.aiType, config.aiBaseUrl) &&
		(config.aiApiKey === undefined || config.aiApiKey === "")
	) {
		issues.push({
			field: "AI_API_KEY",
			reason:
				config.aiType === "openrouter"
					? "AI_API_KEY is required for AI_TYPE=openrouter."
					: "AI_API_KEY is required unless AI_BASE_URL points to a local/custom endpoint.",
		});
	}

	if (config.usingMode === undefined) {
		issues.push({
			field: "USING_MODE",
			reason: `USING_MODE is missing. Supported values: ${SUPPORTED_USING_MODES.join(", ")}`,
		});
	}

	if (config.appEntrypoint === "telegram" && config.telegramBotToken === "") {
		issues.push({
			field: "TELEGRAM_BOT_TOKEN",
			reason: "TELEGRAM_BOT_TOKEN is required when APP_ENTRYPOINT is telegram.",
		});
	}

	if (
		config.appEntrypoint === "telegram" &&
		config.enableVoiceMessages !== false &&
		!canReusePrimaryAiCredentialsForTranscription(
			config.aiType,
			config.transcriptionProvider,
		) &&
		(config.transcriptionApiKey === undefined ||
			config.transcriptionApiKey === "")
	) {
		issues.push({
			field: "TRANSCRIPTION_API_KEY",
			reason:
				"TRANSCRIPTION_API_KEY is not set. Voice transcription will use NoOpTranscriber (transcription capability unavailable).",
		});
	}

	if (
		config.enableImageUnderstanding === true &&
		(config.minimaxApiKey === undefined || config.minimaxApiKey === "")
	) {
		issues.push({
			field: "MINIMAX_API_KEY",
			reason:
				"MINIMAX_API_KEY is required when ENABLE_IMAGE_UNDERSTANDING=true.",
		});
	}

	if (
		config.webHost !== undefined &&
		config.webHost.trim() === ""
	) {
		issues.push({
			field: "WEB_HOST",
			reason: "WEB_HOST must not be empty.",
		});
	}

	if (
		config.webPort !== undefined &&
		(!Number.isFinite(config.webPort) || config.webPort <= 0)
	) {
		issues.push({
			field: "WEB_PORT",
			reason: "WEB_PORT must be a positive integer.",
		});
	}

	if (config.webPublicBaseUrl !== undefined && config.webPublicBaseUrl === "") {
		issues.push({
			field: "WEB_PUBLIC_BASE_URL",
			reason: "WEB_PUBLIC_BASE_URL must not be empty.",
		});
	}

	if (config.timezone !== undefined && !isValidTimezone(config.timezone)) {
		issues.push({
			field: "TIMEZONE",
			reason:
				'TIMEZONE must be a valid IANA timezone, for example "UTC" or "America/New_York".',
		});
	}

	for (const field of [
		"AI_RECURSION_LIMIT",
		"MAX_CONTEXT_WINDOW_TOKENS",
		"CONTEXT_RESERVE_SUMMARY_TOKENS",
		"CONTEXT_RESERVE_RECENT_TURN_TOKENS",
		"CONTEXT_RESERVE_NEXT_TURN_TOKENS",
	] as const) {
		const rawValue = getEnv(field, persistedValues);
		if (rawValue === "") {
			continue;
		}

		if (Number.isNaN(parsePositiveInteger(rawValue))) {
			issues.push({
				field,
				reason: `${field} must be a positive integer.`,
			});
		}
	}

	for (const field of ["AI_TEMPERATURE", "AI_SUB_AGENT_TEMPERATURE"] as const) {
		const rawValue = getEnv(field, persistedValues);
		if (rawValue === "") {
			continue;
		}

		if (Number.isNaN(parseTemperature(rawValue))) {
			issues.push({
				field,
				reason: `${field} must be a number between 0 and 1.`,
			});
		}
	}

	if (
		config.maxContextWindowTokens !== undefined &&
		config.contextReserveSummaryTokens !== undefined &&
		config.contextReserveRecentTurnTokens !== undefined &&
		config.contextReserveNextTurnTokens !== undefined
	) {
		const totalContextReserves =
			config.contextReserveSummaryTokens +
			config.contextReserveRecentTurnTokens +
			config.contextReserveNextTurnTokens;
		if (config.maxContextWindowTokens <= config.contextReserveNextTurnTokens) {
			issues.push({
				field: "MAX_CONTEXT_WINDOW_TOKENS",
				reason:
					"MAX_CONTEXT_WINDOW_TOKENS must be greater than CONTEXT_RESERVE_NEXT_TURN_TOKENS.",
			});
		}
		if (config.maxContextWindowTokens <= totalContextReserves) {
			issues.push({
				field: "MAX_CONTEXT_WINDOW_TOKENS",
				reason:
					"MAX_CONTEXT_WINDOW_TOKENS must be greater than the sum of CONTEXT_RESERVE_SUMMARY_TOKENS, CONTEXT_RESERVE_RECENT_TURN_TOKENS, and CONTEXT_RESERVE_NEXT_TURN_TOKENS.",
			});
		}
	}

	if (
		config.telegramAllowedChatId !== undefined &&
		config.telegramAllowedChatId !== "" &&
		!/^[-]?\d+$/.test(config.telegramAllowedChatId)
	) {
		issues.push({
			field: "TELEGRAM_BOT_ALLOWED_CHAT_ID",
			reason:
				'TELEGRAM_BOT_ALLOWED_CHAT_ID must be a numeric Telegram chat id, for example "123456789" or "-1001234567890".',
		});
	}

	return dedupeIssues(issues);
};

const dedupeIssues = (issues: ConfigIssue[]): ConfigIssue[] => {
	const seen = new Set<string>();
	return issues.filter((issue) => {
		const key = `${issue.field}:${issue.reason}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
};

const explainMissingConfig = (issues: ConfigIssue[]): void => {
	console.log("Environment is missing required model configuration.");
	for (const issue of issues) {
		console.log(`- ${issue.reason}`);
	}
	console.log("Starting setup wizard for the missing values.");
};

const promptRequiredValue = (
	promptUser: WizardPrompt,
	message: string,
	validate: (value: string) => string | null,
): string => {
	while (true) {
		const response = normalize(promptUser(message));
		const error = validate(response);
		if (error === null) {
			return response;
		}
		console.log(error);
	}
};

const promptOptionalValue = (
	promptUser: WizardPrompt,
	message: string,
	fallback = "",
): string => {
	const response = normalize(promptUser(message));
	return response === "" ? fallback : response;
};

const renderSelectorScreen = <TValue extends string>(
	title: string,
	description: string,
	options: readonly WizardOption<TValue>[],
	activeIndex: number,
): string => {
	const lines = [
		title,
		description,
		"",
		...options.map((option, index) =>
			index === activeIndex ? `> ${option.label}` : `  ${option.label}`,
		),
		"",
		"Use ↑/↓ to move and Enter to confirm.",
	];

	return lines.join("\n");
};

const interactiveSelectValue = async <TValue extends string>(
	title: string,
	description: string,
	options: readonly WizardOption<TValue>[],
): Promise<TValue> => {
	const stdin = process.stdin;
	const stdout = process.stdout;

	if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
		throw new Error("Interactive selector requires a TTY.");
	}

	emitKeypressEvents(stdin);
	const previousRawMode = stdin.isRaw;
	let activeIndex = 0;

	const render = () => {
		cursorTo(stdout, 0, 0);
		clearScreenDown(stdout);
		stdout.write(
			`${renderSelectorScreen(title, description, options, activeIndex)}\n`,
		);
	};

	return await new Promise<TValue>((resolve, reject) => {
		const cleanup = () => {
			stdin.off("keypress", onKeypress);
			stdin.setRawMode(previousRawMode === true);
			stdout.write("\n");
		};

		const onKeypress = (
			_value: string,
			key: { ctrl?: boolean; name?: string },
		) => {
			if (key.ctrl && key.name === "c") {
				cleanup();
				reject(new Error("Selection cancelled by user."));
				return;
			}

			if (key.name === "up") {
				activeIndex = activeIndex === 0 ? options.length - 1 : activeIndex - 1;
				render();
				return;
			}

			if (key.name === "down") {
				activeIndex = activeIndex === options.length - 1 ? 0 : activeIndex + 1;
				render();
				return;
			}

			if (key.name === "return") {
				const selected = options[activeIndex];
				cleanup();
				resolve(selected.value);
			}
		};

		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("keypress", onKeypress);
		render();
	});
};

const promptSelectValue = async <TValue extends string>(
	title: string,
	description: string,
	options: readonly WizardOption<TValue>[],
	selectValue?: WizardSelect,
): Promise<TValue> => {
	if (selectValue) {
		return selectValue(title, description, options);
	}

	return interactiveSelectValue(title, description, options);
};

const promptEntrypoint = async (
	initialConfig: Partial<AppConfig>,
	selectValue?: WizardSelect,
): Promise<AppEntrypoint> => {
	if (initialConfig.appEntrypoint) {
		return initialConfig.appEntrypoint;
	}

	return promptSelectValue(
		"Step 1. Choose APP_ENTRYPOINT.",
		"This decides how the assistant receives user input.",
		APP_ENTRYPOINT_OPTIONS,
		selectValue,
	);
};

const promptAiType = async (
	initialConfig: Partial<AppConfig>,
	selectValue?: WizardSelect,
): Promise<SupportedAiTypes> => {
	if (initialConfig.aiType) {
		return initialConfig.aiType;
	}

	return promptSelectValue(
		"Step 2. Choose AI_TYPE.",
		"This decides which provider SDK the bot uses.",
		AI_TYPE_OPTIONS,
		selectValue,
	);
};

const promptUsingMode = async (
	initialConfig: Partial<AppConfig>,
	selectValue?: WizardSelect,
): Promise<UsingMode> => {
	if (initialConfig.usingMode) {
		return initialConfig.usingMode;
	}

	return promptSelectValue(
		"Step 6. Choose USING_MODE.",
		'"single" runs one agent, "multi" reserves the multi-agent mode.',
		USING_MODE_OPTIONS,
		selectValue,
	);
};

const runConfigWizard = async (
	initialConfig: Partial<AppConfig>,
	promptUser: WizardPrompt,
	selectValue?: WizardSelect,
): Promise<AppConfig> => {
	const appEntrypoint = await promptEntrypoint(initialConfig, selectValue);
	const aiType = await promptAiType(initialConfig, selectValue);

	const aiModelName =
		initialConfig.aiModelName && initialConfig.aiModelName !== ""
			? initialConfig.aiModelName
			: promptRequiredValue(
					promptUser,
					`Step 3. Enter AI_MODEL_NAME for ${aiType}.
Example: claude-3-5-sonnet or gpt-4.1> `,
					(value) => (value === "" ? "AI_MODEL_NAME cannot be empty." : null),
				);

	const aiBaseUrl =
		initialConfig.aiBaseUrl && initialConfig.aiBaseUrl !== ""
			? initialConfig.aiBaseUrl
			: promptOptionalValue(
					promptUser,
					`Step 4. Enter AI_BASE_URL for ${aiType} if you use a custom endpoint.
Press enter to use the provider default.> `,
					"",
				);
	const aiApiKey =
		initialConfig.aiApiKey && initialConfig.aiApiKey !== ""
			? initialConfig.aiApiKey
			: isAiApiKeyRequired(aiType, aiBaseUrl)
				? promptRequiredValue(
						promptUser,
						`Step 5. Enter AI_API_KEY for ${aiType}.
This is required for the selected provider settings.> `,
						(value) => (value === "" ? "AI_API_KEY cannot be empty." : null),
					)
				: promptOptionalValue(
						promptUser,
						`Step 5. Enter AI_API_KEY for ${aiType} if your local/custom endpoint still expects one.
Press enter to leave it empty.> `,
						"",
					);
	const transcriptionProvider =
		initialConfig.transcriptionProvider ??
		defaultTranscriptionProviderForAiType(aiType);
	const transcriptionApiKey =
		initialConfig.transcriptionApiKey &&
		initialConfig.transcriptionApiKey !== ""
			? initialConfig.transcriptionApiKey
			: canReusePrimaryAiCredentialsForTranscription(
						aiType,
						transcriptionProvider,
					)
				? aiApiKey
				: appEntrypoint === "telegram" &&
						(initialConfig.enableVoiceMessages ?? DEFAULT_ENABLE_VOICE_MESSAGES)
					? promptOptionalValue(
							promptUser,
							`Voice step. Enter TRANSCRIPTION_API_KEY for ${transcriptionProvider}.
Press enter to skip (transcription will not be available).> `,
							"",
						)
					: "";
	const transcriptionBaseUrl = initialConfig.transcriptionBaseUrl ?? "";

	const usingMode = await promptUsingMode(initialConfig, selectValue);

	const telegramBotToken =
		appEntrypoint === "telegram"
			? initialConfig.telegramBotToken && initialConfig.telegramBotToken !== ""
				? initialConfig.telegramBotToken
				: promptRequiredValue(
						promptUser,
						`Telegram step. Enter TELEGRAM_BOT_TOKEN.
Create it with BotFather and paste the bot token here.> `,
						(value) =>
							value === "" ? "TELEGRAM_BOT_TOKEN cannot be empty." : null,
					)
			: (initialConfig.telegramBotToken ?? "");

	const telegramAllowedChatId =
		appEntrypoint === "telegram"
			? promptOptionalValue(
					promptUser,
					`Telegram step. Enter TELEGRAM_BOT_ALLOWED_CHAT_ID if you want to restrict access.
Press enter to allow any chat the bot is added to.> `,
					initialConfig.telegramAllowedChatId ?? "",
				)
			: (initialConfig.telegramAllowedChatId ?? "");

	if (
		telegramAllowedChatId !== "" &&
		!/^[-]?\d+$/.test(telegramAllowedChatId)
	) {
		console.log(
			'TELEGRAM_BOT_ALLOWED_CHAT_ID must be numeric, for example "123456789" or "-1001234567890".',
		);
		return runConfigWizard(
			{
				...initialConfig,
				appEntrypoint,
				aiApiKey,
				aiBaseUrl,
				aiModelName,
				aiType,
				telegramBotToken,
				usingMode,
			},
			promptUser,
			selectValue,
		);
	}

	return {
		aiApiKey,
		aiBaseUrl,
		aiModelName,
		aiTemperature:
			initialConfig.aiTemperature !== undefined &&
			Number.isFinite(initialConfig.aiTemperature)
				? initialConfig.aiTemperature
				: DEFAULT_AI_TEMPERATURE,
		aiSubAgentTemperature:
			initialConfig.aiSubAgentTemperature !== undefined &&
			Number.isFinite(initialConfig.aiSubAgentTemperature)
				? initialConfig.aiSubAgentTemperature
				: DEFAULT_AI_SUB_AGENT_TEMPERATURE,
		aiType,
		appEntrypoint,
		telegramAllowedChatId,
		telegramBotToken,
		usingMode,
		blockedUserMessage:
			initialConfig.blockedUserMessage ?? DEFAULT_BLOCKED_USER_MESSAGE,
		maxContextWindowTokens:
			initialConfig.maxContextWindowTokens ?? DEFAULT_MAX_CONTEXT_WINDOW_TOKENS,
		contextReserveSummaryTokens:
			initialConfig.contextReserveSummaryTokens ??
			DEFAULT_CONTEXT_RESERVE_SUMMARY_TOKENS,
		contextReserveRecentTurnTokens:
			initialConfig.contextReserveRecentTurnTokens ??
			DEFAULT_CONTEXT_RESERVE_RECENT_TURN_TOKENS,
		contextReserveNextTurnTokens:
			initialConfig.contextReserveNextTurnTokens ??
			DEFAULT_CONTEXT_RESERVE_NEXT_TURN_TOKENS,
		permissionsMode: initialConfig.permissionsMode ?? "enforce",
		databaseUrl: initialConfig.databaseUrl ?? DEFAULT_DATABASE_URL,
		enableExecute: initialConfig.enableExecute ?? true,
		enableVoiceMessages:
			initialConfig.enableVoiceMessages ?? DEFAULT_ENABLE_VOICE_MESSAGES,
		enablePdfDocuments:
			initialConfig.enablePdfDocuments ?? DEFAULT_ENABLE_PDF_DOCUMENTS,
		enableSpreadsheets:
			initialConfig.enableSpreadsheets ?? DEFAULT_ENABLE_SPREADSHEETS,
		enableImageUnderstanding:
			initialConfig.enableImageUnderstanding ??
			DEFAULT_ENABLE_IMAGE_UNDERSTANDING,
		enableToolStatus:
			initialConfig.enableToolStatus ?? DEFAULT_ENABLE_TOOL_STATUS,
		enableAttachmentCompactionNotice:
			initialConfig.enableAttachmentCompactionNotice ??
			DEFAULT_ENABLE_ATTACHMENT_COMPACTION_NOTICE,
		enableBrowserOnParent:
			initialConfig.enableBrowserOnParent ?? DEFAULT_ENABLE_BROWSER_ON_PARENT,
		enableTabular: initialConfig.enableTabular ?? DEFAULT_ENABLE_TABULAR,
		defaultStatusLocale:
			initialConfig.defaultStatusLocale ?? DEFAULT_STATUS_LOCALE,
		transcriptionProvider,
		transcriptionApiKey,
		transcriptionBaseUrl,
		minimaxApiKey: initialConfig.minimaxApiKey ?? "",
		minimaxApiHost: initialConfig.minimaxApiHost || DEFAULT_MINIMAX_API_HOST,
		webHost: initialConfig.webHost || DEFAULT_WEB_HOST,
		webPort: initialConfig.webPort ?? DEFAULT_WEB_PORT,
		webPublicBaseUrl:
			initialConfig.webPublicBaseUrl || DEFAULT_WEB_PUBLIC_BASE_URL,
		timezone: initialConfig.timezone ?? DEFAULT_TIMEZONE,
		recursionLimit: initialConfig.recursionLimit ?? DEFAULT_RECURSION_LIMIT,
	};
};

const escapeEnvValue = (value: string): string => JSON.stringify(value);

const formatPersistedEnvLine = (
	key: (typeof PERSISTED_ENV_KEYS)[number],
	config: AppConfig,
): string => {
	switch (key) {
		case "AI_API_KEY":
			return `${key}=${escapeEnvValue(config.aiApiKey)}`;
		case "AI_BASE_URL":
			return `${key}=${escapeEnvValue(config.aiBaseUrl)}`;
		case "AI_MODEL_NAME":
			return `${key}=${escapeEnvValue(config.aiModelName)}`;
		case "AI_RECURSION_LIMIT":
			return `${key}=${escapeEnvValue(String(config.recursionLimit))}`;
		case "AI_SUB_AGENT_TEMPERATURE":
			return `${key}=${escapeEnvValue(String(config.aiSubAgentTemperature))}`;
		case "AI_TEMPERATURE":
			return `${key}=${escapeEnvValue(String(config.aiTemperature))}`;
		case "AI_TYPE":
			return `${key}=${escapeEnvValue(config.aiType)}`;
		case "APP_ENTRYPOINT":
			return `${key}=${escapeEnvValue(config.appEntrypoint)}`;
		case "BLOCKED_USER_MESSAGE":
			return `${key}=${escapeEnvValue(config.blockedUserMessage)}`;
		case "CONTEXT_RESERVE_NEXT_TURN_TOKENS":
			return `${key}=${escapeEnvValue(
				String(config.contextReserveNextTurnTokens),
			)}`;
		case "CONTEXT_RESERVE_RECENT_TURN_TOKENS":
			return `${key}=${escapeEnvValue(
				String(config.contextReserveRecentTurnTokens),
			)}`;
		case "CONTEXT_RESERVE_SUMMARY_TOKENS":
			return `${key}=${escapeEnvValue(
				String(config.contextReserveSummaryTokens),
			)}`;
		case "ENABLE_EXECUTE":
			return `${key}=${escapeEnvValue(config.enableExecute ? "true" : "false")}`;
		case "ENABLE_IMAGE_UNDERSTANDING":
			return `${key}=${escapeEnvValue(
				config.enableImageUnderstanding ? "true" : "false",
			)}`;
		case "ENABLE_PDF_DOCUMENTS":
			return `${key}=${escapeEnvValue(
				config.enablePdfDocuments ? "true" : "false",
			)}`;
		case "ENABLE_SPREADSHEETS":
			return `${key}=${escapeEnvValue(
				config.enableSpreadsheets ? "true" : "false",
			)}`;
		case "ENABLE_ATTACHMENT_COMPACTION_NOTICE":
			return `${key}=${escapeEnvValue(
				config.enableAttachmentCompactionNotice ? "true" : "false",
			)}`;
		case "ENABLE_BROWSER_ON_PARENT":
			return `${key}=${escapeEnvValue(
				config.enableBrowserOnParent ? "true" : "false",
			)}`;
		case "ENABLE_TABULAR":
			return `${key}=${escapeEnvValue(config.enableTabular ? "true" : "false")}`;
		case "ENABLE_TOOL_STATUS":
			return `${key}=${escapeEnvValue(
				config.enableToolStatus ? "true" : "false",
			)}`;
		case "DEFAULT_STATUS_LOCALE":
			return `${key}=${escapeEnvValue(config.defaultStatusLocale)}`;
		case "ENABLE_VOICE_MESSAGES":
			return `${key}=${escapeEnvValue(
				config.enableVoiceMessages ? "true" : "false",
			)}`;
		case "MAX_CONTEXT_WINDOW_TOKENS":
			return `${key}=${escapeEnvValue(String(config.maxContextWindowTokens))}`;
		case "MINIMAX_API_HOST":
			return `${key}=${escapeEnvValue(config.minimaxApiHost)}`;
		case "MINIMAX_API_KEY":
			return `${key}=${escapeEnvValue(config.minimaxApiKey)}`;
		case "PERMISSIONS_MODE":
			return `${key}=${escapeEnvValue(config.permissionsMode)}`;
		case "DATABASE_URL":
			return `${key}=${escapeEnvValue(config.databaseUrl)}`;
		case "TELEGRAM_BOT_ALLOWED_CHAT_ID":
			return `${key}=${escapeEnvValue(config.telegramAllowedChatId)}`;
		case "TELEGRAM_BOT_TOKEN":
			return `${key}=${escapeEnvValue(config.telegramBotToken)}`;
		case "TIMEZONE":
			return `${key}=${escapeEnvValue(config.timezone)}`;
		case "TRANSCRIPTION_API_KEY":
			return `${key}=${escapeEnvValue(config.transcriptionApiKey)}`;
		case "TRANSCRIPTION_BASE_URL":
			return `${key}=${escapeEnvValue(config.transcriptionBaseUrl)}`;
		case "TRANSCRIPTION_PROVIDER":
			return `${key}=${escapeEnvValue(config.transcriptionProvider)}`;
		case "USING_MODE":
			return `${key}=${escapeEnvValue(config.usingMode)}`;
		case "WEB_HOST":
			return `${key}=${escapeEnvValue(config.webHost)}`;
		case "WEB_PORT":
			return `${key}=${escapeEnvValue(String(config.webPort))}`;
		case "WEB_PUBLIC_BASE_URL":
			return `${key}=${escapeEnvValue(config.webPublicBaseUrl)}`;
	}
};

const parseEnvAssignmentValue = (rawValue: string): string => {
	const trimmed = rawValue.trim();
	if (trimmed === "") {
		return "";
	}

	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return trimmed.slice(1, -1);
		}
	}

	return trimmed;
};

export const readPersistedEnvFile = (
	envFilePath = DEFAULT_ENV_FILE_PATH,
): PersistedEnvValues => {
	if (!existsSync(envFilePath)) {
		return {};
	}

	const persistedValues: PersistedEnvValues = {};
	const envContent = readFileSync(envFilePath, "utf8");
	for (const line of envContent.replace(/\r\n/g, "\n").split("\n")) {
		const match = line.match(PERSISTED_ENV_ASSIGNMENT_REGEX);
		if (!match) {
			continue;
		}

		const key = match[1] as ConfigIssueField;
		persistedValues[key] = parseEnvAssignmentValue(match[2]);
	}

	return persistedValues;
};

const persistConfigToEnvFile = (
	config: AppConfig,
	envFilePath = DEFAULT_ENV_FILE_PATH,
): void => {
	const nextLinesByKey = new Map(
		PERSISTED_ENV_KEYS.map((key) => [key, formatPersistedEnvLine(key, config)]),
	);
	const existingContent = existsSync(envFilePath)
		? readFileSync(envFilePath, "utf8")
		: "";
	const existingLines =
		existingContent === ""
			? []
			: existingContent.replace(/\r\n/g, "\n").split("\n");
	const seenKeys = new Set<(typeof PERSISTED_ENV_KEYS)[number]>();
	const updatedLines = existingLines.map((line) => {
		const match = line.match(PERSISTED_ENV_LINE_REGEX);
		if (!match) {
			return line;
		}

		const key = match[1] as (typeof PERSISTED_ENV_KEYS)[number];
		seenKeys.add(key);
		return nextLinesByKey.get(key) ?? line;
	});

	for (const key of PERSISTED_ENV_KEYS) {
		if (!seenKeys.has(key)) {
			updatedLines.push(nextLinesByKey.get(key) ?? "");
		}
	}

	const persistedContent = `${updatedLines.join("\n").replace(/\n+$/u, "")}\n`;
	writeFileSync(envFilePath, persistedContent, "utf8");
};

const canRunWizard = (): boolean =>
	process.stdin.isTTY === true && process.stdout.isTTY === true;

export const maskSecret = (value: string): string => {
	if (value === "") {
		return "<empty>";
	}

	if (value.length <= 6) {
		return `${value.slice(0, 1)}***${value.slice(-1)}`;
	}

	return `${value.slice(0, 3)}***${value.slice(-3)}`;
};

export const resolveConfig = async (
	options: ResolveConfigOptions = {},
): Promise<AppConfig> => {
	const persistedValues = readPersistedEnvFile(options.envFilePath);
	const config = readConfigFromEnv(persistedValues);
	const issues = findConfigIssues(config, persistedValues);

	if (issues.length === 0) {
		const resolvedConfig: AppConfig = {
			aiApiKey: config.aiApiKey ?? "",
			aiBaseUrl: config.aiBaseUrl ?? "",
			aiModelName: config.aiModelName ?? "",
			aiTemperature: config.aiTemperature ?? DEFAULT_AI_TEMPERATURE,
			aiSubAgentTemperature:
				config.aiSubAgentTemperature ?? DEFAULT_AI_SUB_AGENT_TEMPERATURE,
			aiType: config.aiType ?? DEFAULT_AI_TYPE,
			appEntrypoint: config.appEntrypoint ?? DEFAULT_APP_ENTRYPOINT,
			telegramAllowedChatId: config.telegramAllowedChatId ?? "",
			telegramBotToken: config.telegramBotToken ?? "",
			usingMode: config.usingMode ?? DEFAULT_USING_MODE,
			blockedUserMessage:
				config.blockedUserMessage ?? DEFAULT_BLOCKED_USER_MESSAGE,
			maxContextWindowTokens:
				config.maxContextWindowTokens ?? DEFAULT_MAX_CONTEXT_WINDOW_TOKENS,
			contextReserveSummaryTokens:
				config.contextReserveSummaryTokens ??
				DEFAULT_CONTEXT_RESERVE_SUMMARY_TOKENS,
			contextReserveRecentTurnTokens:
				config.contextReserveRecentTurnTokens ??
				DEFAULT_CONTEXT_RESERVE_RECENT_TURN_TOKENS,
			contextReserveNextTurnTokens:
				config.contextReserveNextTurnTokens ??
				DEFAULT_CONTEXT_RESERVE_NEXT_TURN_TOKENS,
			permissionsMode: config.permissionsMode ?? "enforce",
			databaseUrl: config.databaseUrl ?? DEFAULT_DATABASE_URL,
			enableExecute: config.enableExecute ?? true,
			enableVoiceMessages:
				config.enableVoiceMessages ?? DEFAULT_ENABLE_VOICE_MESSAGES,
			enablePdfDocuments:
				config.enablePdfDocuments ?? DEFAULT_ENABLE_PDF_DOCUMENTS,
			enableSpreadsheets:
				config.enableSpreadsheets ?? DEFAULT_ENABLE_SPREADSHEETS,
			enableImageUnderstanding:
				config.enableImageUnderstanding ?? DEFAULT_ENABLE_IMAGE_UNDERSTANDING,
			enableToolStatus: config.enableToolStatus ?? DEFAULT_ENABLE_TOOL_STATUS,
			enableAttachmentCompactionNotice:
				config.enableAttachmentCompactionNotice ??
				DEFAULT_ENABLE_ATTACHMENT_COMPACTION_NOTICE,
			enableBrowserOnParent:
				config.enableBrowserOnParent ?? DEFAULT_ENABLE_BROWSER_ON_PARENT,
			enableTabular: config.enableTabular ?? DEFAULT_ENABLE_TABULAR,
			defaultStatusLocale: config.defaultStatusLocale ?? DEFAULT_STATUS_LOCALE,
			transcriptionProvider:
				config.transcriptionProvider ??
				defaultTranscriptionProviderForAiType(config.aiType),
			transcriptionApiKey: config.transcriptionApiKey ?? "",
			transcriptionBaseUrl: config.transcriptionBaseUrl ?? "",
			minimaxApiKey: config.minimaxApiKey ?? "",
			minimaxApiHost: config.minimaxApiHost || DEFAULT_MINIMAX_API_HOST,
			webHost: config.webHost || DEFAULT_WEB_HOST,
			webPort: config.webPort ?? DEFAULT_WEB_PORT,
			webPublicBaseUrl: config.webPublicBaseUrl || DEFAULT_WEB_PUBLIC_BASE_URL,
			timezone: config.timezone ?? DEFAULT_TIMEZONE,
			recursionLimit: config.recursionLimit ?? DEFAULT_RECURSION_LIMIT,
		};
		return resolvedConfig;
	}

	const promptUser = options.promptUser ?? defaultPrompt;
	const allowWizard =
		options.promptUser !== undefined ||
		options.selectValue !== undefined ||
		canRunWizard();

	if (!allowWizard) {
		throw new Error(issues.map((issue) => issue.reason).join("\n"));
	}

	explainMissingConfig(issues);
	const resolvedConfig = await runConfigWizard(
		config,
		promptUser,
		options.selectValue,
	);
	persistConfigToEnvFile(resolvedConfig, options.envFilePath);
	return resolvedConfig;
};
