import { clearScreenDown, cursorTo, emitKeypressEvents } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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

export type AppConfig = {
	aiApiKey: string;
	aiBaseUrl: string;
	aiType: SupportedAiTypes;
	aiModelName: string;
	appEntrypoint: AppEntrypoint;
	telegramBotToken: string;
	telegramAllowedChatId: string;
	usingMode: UsingMode;
	blockedUserMessage: string;
	permissionsMode: "enforce" | "disabled";
	stateDbPath: string;
};

const DEFAULT_BLOCKED_USER_MESSAGE =
	"Access not configured. Contact the admin.";
const DEFAULT_STATE_DB_PATH = "./state.db";

type ConfigIssueField =
	| "AI_API_KEY"
	| "AI_BASE_URL"
	| "AI_MODEL_NAME"
	| "AI_TYPE"
	| "APP_ENTRYPOINT"
	| "BLOCKED_USER_MESSAGE"
	| "PERMISSIONS_MODE"
	| "STATE_DB_PATH"
	| "TELEGRAM_BOT_ALLOWED_CHAT_ID"
	| "TELEGRAM_BOT_TOKEN"
	| "USING_MODE";

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
	"AI_TYPE",
	"APP_ENTRYPOINT",
	"BLOCKED_USER_MESSAGE",
	"PERMISSIONS_MODE",
	"STATE_DB_PATH",
	"TELEGRAM_BOT_ALLOWED_CHAT_ID",
	"TELEGRAM_BOT_TOKEN",
	"USING_MODE",
] as const;

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

export const readConfigFromEnv = (
	persistedValues: PersistedEnvValues = {},
): Partial<AppConfig> => {
	const aiTypeValue = getEnv("AI_TYPE", persistedValues);
	const usingModeValue = getEnv("USING_MODE", persistedValues);
	const entrypointValue = getEnv("APP_ENTRYPOINT", persistedValues);

	const permissionsModeRaw = getEnv("PERMISSIONS_MODE", persistedValues);
	const permissionsMode =
		permissionsModeRaw === "disabled" ? "disabled" : "enforce";

	return {
		aiApiKey: getEnv("AI_API_KEY", persistedValues),
		aiBaseUrl: getEnv("AI_BASE_URL", persistedValues),
		aiModelName: getEnv("AI_MODEL_NAME", persistedValues),
		appEntrypoint: checkAppEntrypoint(entrypointValue)
			? entrypointValue
			: undefined,
		aiType: checkAiType(aiTypeValue) ? aiTypeValue : undefined,
		telegramAllowedChatId: getEnv("TELEGRAM_BOT_ALLOWED_CHAT_ID", persistedValues),
		telegramBotToken: getEnv("TELEGRAM_BOT_TOKEN", persistedValues),
		usingMode: checkUsingMode(usingModeValue) ? usingModeValue : undefined,
		blockedUserMessage:
			getEnv("BLOCKED_USER_MESSAGE", persistedValues) ||
			DEFAULT_BLOCKED_USER_MESSAGE,
		permissionsMode,
		stateDbPath: getEnv("STATE_DB_PATH", persistedValues) || DEFAULT_STATE_DB_PATH,
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

	if (config.aiModelName === undefined || config.aiModelName === "") {
		issues.push({
			field: "AI_MODEL_NAME",
			reason: "AI_MODEL_NAME is missing.",
		});
	}

	if (config.aiApiKey === undefined || config.aiApiKey === "") {
		issues.push({
			field: "AI_API_KEY",
			reason: "AI_API_KEY is missing.",
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

	const aiApiKey =
		initialConfig.aiApiKey && initialConfig.aiApiKey !== ""
			? initialConfig.aiApiKey
			: promptRequiredValue(
					promptUser,
					`Step 4. Enter AI_API_KEY for ${aiType}.
This is the credential used to call the selected model provider.> `,
					(value) => (value === "" ? "AI_API_KEY cannot be empty." : null),
				);

	const aiBaseUrl = promptOptionalValue(
		promptUser,
		`Step 5. Enter AI_BASE_URL for ${aiType} if you use a custom endpoint.
Press enter to use the provider default.> `,
		initialConfig.aiBaseUrl ?? "",
	);

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
		aiType,
		appEntrypoint,
		telegramAllowedChatId,
		telegramBotToken,
		usingMode,
		blockedUserMessage:
			initialConfig.blockedUserMessage ?? DEFAULT_BLOCKED_USER_MESSAGE,
		permissionsMode: initialConfig.permissionsMode ?? "enforce",
		stateDbPath: initialConfig.stateDbPath ?? DEFAULT_STATE_DB_PATH,
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
		case "AI_TYPE":
			return `${key}=${escapeEnvValue(config.aiType)}`;
		case "APP_ENTRYPOINT":
			return `${key}=${escapeEnvValue(config.appEntrypoint)}`;
		case "BLOCKED_USER_MESSAGE":
			return `${key}=${escapeEnvValue(config.blockedUserMessage)}`;
		case "PERMISSIONS_MODE":
			return `${key}=${escapeEnvValue(config.permissionsMode)}`;
		case "STATE_DB_PATH":
			return `${key}=${escapeEnvValue(config.stateDbPath)}`;
		case "TELEGRAM_BOT_ALLOWED_CHAT_ID":
			return `${key}=${escapeEnvValue(config.telegramAllowedChatId)}`;
		case "TELEGRAM_BOT_TOKEN":
			return `${key}=${escapeEnvValue(config.telegramBotToken)}`;
		case "USING_MODE":
			return `${key}=${escapeEnvValue(config.usingMode)}`;
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

const readPersistedEnvFile = (
	envFilePath = DEFAULT_ENV_FILE_PATH,
): PersistedEnvValues => {
	if (!existsSync(envFilePath)) {
		return {};
	}

	const persistedValues: PersistedEnvValues = {};
	const envContent = readFileSync(envFilePath, "utf8");
	for (const line of envContent.replace(/\r\n/g, "\n").split("\n")) {
		const match = line.match(
			/^(AI_API_KEY|AI_BASE_URL|AI_MODEL_NAME|AI_TYPE|APP_ENTRYPOINT|BLOCKED_USER_MESSAGE|PERMISSIONS_MODE|STATE_DB_PATH|TELEGRAM_BOT_ALLOWED_CHAT_ID|TELEGRAM_BOT_TOKEN|USING_MODE)=(.*)$/u,
		);
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
		existingContent === "" ? [] : existingContent.replace(/\r\n/g, "\n").split("\n");
	const seenKeys = new Set<(typeof PERSISTED_ENV_KEYS)[number]>();
	const updatedLines = existingLines.map((line) => {
		const match = line.match(
			/^(AI_API_KEY|AI_BASE_URL|AI_MODEL_NAME|AI_TYPE|APP_ENTRYPOINT|BLOCKED_USER_MESSAGE|PERMISSIONS_MODE|STATE_DB_PATH|TELEGRAM_BOT_ALLOWED_CHAT_ID|TELEGRAM_BOT_TOKEN|USING_MODE)=/,
		);
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
			aiType: config.aiType ?? DEFAULT_AI_TYPE,
			appEntrypoint: config.appEntrypoint ?? DEFAULT_APP_ENTRYPOINT,
			telegramAllowedChatId: config.telegramAllowedChatId ?? "",
			telegramBotToken: config.telegramBotToken ?? "",
			usingMode: config.usingMode ?? DEFAULT_USING_MODE,
			blockedUserMessage:
				config.blockedUserMessage ?? DEFAULT_BLOCKED_USER_MESSAGE,
			permissionsMode: config.permissionsMode ?? "enforce",
			stateDbPath: config.stateDbPath ?? DEFAULT_STATE_DB_PATH,
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
