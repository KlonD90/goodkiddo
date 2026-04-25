import type { SupportedLocale } from "../i18n/locale.js";

export interface StatusTemplateArgs {
	[key: string]: unknown;
}

export interface StatusResult {
	message: string;
	truncated: boolean;
}

const MAX_VALUE_LENGTH = 100;
const MAX_TOTAL_LENGTH = 200;

const ALLOWLISTED_ARGS: Record<string, readonly string[]> = {
	ls: ["path"],
	read_file: ["file_path", "offset", "limit", "offsetLimit"],
	write_file: ["file_path"],
	edit_file: ["file_path", "replace_all", "replaceAll"],
	glob: ["pattern", "path"],
	grep: ["pattern", "path", "glob", "pathGlob"],
	browser_snapshot: [
		"url",
		"selector",
		"interactiveOnly",
		"sessionKey",
		"urlSelector",
	],
	browser_action: [
		"sessionKey",
		"action",
		"ref",
		"direction",
		"amount",
		"ms",
		"until",
		"directionText",
	], // direction is in allowlist but handled via directionText
	execute_script: ["runtime", "script", "filename", "args"],
	execute_workspace: ["runtime", "entrypoint", "args"],
	memory_write: ["topic", "mode"],
	skill_write: ["name", "mode"],
	memory_append_log: ["op", "detail"],
	task_add: ["listName", "title", "note"],
	task_complete: ["taskId"],
	task_dismiss: ["taskId", "reason"],
	task_list_active: ["limit"],
	send_file: ["file_path", "caption"],
	grant_fs_access: ["scope_path", "ttl_hours", "note"],
	understand_image: ["prompt"],
};

type ToolTemplates = Record<string, string>;

type LocaleDictionary = Record<SupportedLocale, ToolTemplates>;

const dictionaries: LocaleDictionary = {
	en: {
		ls: "Listing {path}",
		read_file: "Reading {file_path}{offsetLimit}",
		write_file: "Writing to {file_path}",
		edit_file: "Editing {file_path}{replaceAll}",
		glob: "Finding files matching {pattern}",
		grep: "Searching for {pattern}{pathGlob}",
		browser_snapshot: "Taking browser snapshot{urlSelector}",
		browser_action: "Browser action: {action}{directionText}",
		execute_script: "Running script {script}",
		execute_workspace: "Running workspace entrypoint {entrypoint}",
		memory_write: "Writing note: {topic}",
		skill_write: "Writing skill: {name}",
		memory_append_log: "Appending to log: {op}",
		task_add: "Adding task to {listName}",
		task_complete: "Completing task {taskId}",
		task_dismiss: "Dismissing task {taskId}",
		task_list_active: "Listing active tasks",
		send_file: "Sending file {file_path}",
		grant_fs_access: "Creating share link for {scope_path}",
		understand_image: "Analyzing image: {prompt}",
	},
	ru: {
		ls: "Просмотр {path}",
		read_file: "Чтение {file_path}{offsetLimit}",
		write_file: "Запись в {file_path}",
		edit_file: "Редактирование {file_path}{replaceAll}",
		glob: "Поиск файлов по шаблону {pattern}",
		grep: "Поиск {pattern}{pathGlob}",
		browser_snapshot: "Снимок браузера{urlSelector}",
		browser_action: "Действие браузера: {action}{directionText}",
		execute_script: "Запуск скрипта {script}",
		execute_workspace: "Запуск из рабочей области {entrypoint}",
		memory_write: "Запись заметки: {topic}",
		skill_write: "Запись навыка: {name}",
		memory_append_log: "Добавление в лог: {op}",
		task_add: "Добавление задачи в {listName}",
		task_complete: "Завершение задачи {taskId}",
		task_dismiss: "Отклонение задачи {taskId}",
		task_list_active: "Список активных задач",
		send_file: "Отправка файла {file_path}",
		grant_fs_access: "Создание ссылки для {scope_path}",
		understand_image: "Анализ изображения: {prompt}",
	},
	es: {
		ls: "Listando {path}",
		read_file: "Leyendo {file_path}{offsetLimit}",
		write_file: "Escribiendo en {file_path}",
		edit_file: "Editando {file_path}{replaceAll}",
		glob: "Buscando archivos con patrón {pattern}",
		grep: "Buscando {pattern}{pathGlob}",
		browser_snapshot: "Captura de navegador{urlSelector}",
		browser_action: "Acción de navegador: {action}{directionText}",
		execute_script: "Ejecutando script {script}",
		execute_workspace: "Ejecutando entrada de workspace {entrypoint}",
		memory_write: "Escribiendo nota: {topic}",
		skill_write: "Escribiendo habilidad: {name}",
		memory_append_log: "Añadiendo al log: {op}",
		task_add: "Añadiendo tarea a {listName}",
		task_complete: "Completando tarea {taskId}",
		task_dismiss: "Descartando tarea {taskId}",
		task_list_active: "Listando tareas activas",
		send_file: "Enviando archivo {file_path}",
		grant_fs_access: "Creando enlace para {scope_path}",
		understand_image: "Analizando imagen: {prompt}",
	},
};

function truncate(
	value: string,
	maxLength: number,
): { value: string; truncated: boolean } {
	const cleaned = value.replace(/[\r\n\t]/g, " ");
	if (cleaned.length <= maxLength) {
		return { value: cleaned, truncated: false };
	}
	return { value: `${cleaned.slice(0, maxLength - 3)}...`, truncated: true };
}

function formatValue(value: unknown): { value: string; truncated: boolean } {
	if (value === null || value === undefined) {
		return { value: "", truncated: false };
	}
	if (typeof value === "boolean") {
		return { value: value ? "yes" : "no", truncated: false };
	}
	if (typeof value === "number") {
		return { value: String(value), truncated: false };
	}
	if (typeof value === "string") {
		const { value: truncated, truncated: wasTruncated } = truncate(
			value,
			MAX_VALUE_LENGTH,
		);
		return { value: truncated, truncated: wasTruncated };
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return { value: "[]", truncated: false };
		if (value.length > 5) {
			return { value: `[${value.length} items]`, truncated: false };
		}
		const results = value.map((v) => formatValue(v));
		const anyTruncated = results.some((r) => r.truncated);
		const formatted = results.map((r) => r.value).join(", ");
		return { value: `[${formatted}]`, truncated: anyTruncated };
	}
	if (typeof value === "object") {
		return { value: JSON.stringify(value), truncated: false };
	}
	return { value: String(value), truncated: false };
}

function interpolate(
	template: string,
	args: StatusTemplateArgs,
	allowlist: readonly string[],
): { message: string; truncated: boolean } {
	let result = template;
	let anyTruncated = false;

	for (const key of allowlist) {
		const value = args[key];
		if (value === undefined) continue;

		const { value: formatted, truncated: wasTruncated } = formatValue(value);
		if (wasTruncated) {
			anyTruncated = true;
		}
		result = result.replace(new RegExp(`\\{${key}\\}`, "g"), formatted);
	}

	const { value: finalResult, truncated: finalTruncated } = truncate(
		result,
		MAX_TOTAL_LENGTH,
	);
	return { message: finalResult, truncated: anyTruncated || finalTruncated };
}

function formatOffsetLimit(args: StatusTemplateArgs): string {
	const offset = args.offset;
	const limit = args.limit;
	if (offset === undefined && limit === undefined) {
		return "";
	}
	const offsetStr = offset !== undefined ? String(offset) : "0";
	const limitStr = limit !== undefined ? String(limit) : "100";
	return ` (lines ${offsetStr}:${limitStr})`;
}

function formatReplaceAll(args: StatusTemplateArgs): string {
	if (args.replace_all === true) {
		return " (all)";
	}
	return "";
}

function formatUrlSelector(args: StatusTemplateArgs): string {
	const parts: string[] = [];
	if (args.url) {
		const url = String(args.url);
		const { value: truncated } = truncate(url, 50);
		parts.push(` ${truncated}`);
	}
	if (args.selector) {
		const selector = String(args.selector);
		const { value: truncated } = truncate(selector, 30);
		parts.push(` selector:${truncated}`);
	}
	return parts.join("");
}

function formatDirectionText(args: StatusTemplateArgs): string {
	const action = args.action as string;
	if (action === "scroll" && args.direction) {
		return ` ${args.direction}`;
	}
	if (action === "click" || action === "fill") {
		if (args.ref) {
			return ` ${args.ref}`;
		}
	}
	if (action === "wait" && args.ms) {
		return ` ${args.ms}ms`;
	}
	return "";
}

function formatPathGlob(args: StatusTemplateArgs): string {
	const parts: string[] = [];
	if (args.path && args.path !== "/") {
		const { value: truncated } = truncate(String(args.path), 40);
		parts.push(` in ${truncated}`);
	}
	if (args.glob) {
		const { value: truncated } = truncate(String(args.glob), 30);
		parts.push(` (${truncated})`);
	}
	return parts.join("");
}

function buildInterpolatedArgs(
	toolName: string,
	args: StatusTemplateArgs,
): StatusTemplateArgs {
	const augmented = { ...args };

	switch (toolName) {
		case "read_file":
			augmented.offsetLimit = formatOffsetLimit(args);
			break;
		case "edit_file":
			augmented.replaceAll = formatReplaceAll(args);
			break;
		case "browser_snapshot":
			augmented.urlSelector = formatUrlSelector(args);
			break;
		case "browser_action":
			augmented.directionText = formatDirectionText(args);
			break;
		case "grep":
			augmented.pathGlob = formatPathGlob(args);
			break;
	}

	return augmented;
}

export function renderStatus(
	toolName: string,
	args: StatusTemplateArgs,
	locale: SupportedLocale,
): StatusResult | null {
	const allowlist = ALLOWLISTED_ARGS[toolName];
	if (!allowlist) {
		return null;
	}

	const template = dictionaries[locale][toolName] ?? dictionaries.en[toolName];
	if (!template) {
		return null;
	}

	const augmentedArgs = buildInterpolatedArgs(toolName, args);
	const { message, truncated } = interpolate(
		template,
		augmentedArgs,
		allowlist,
	);

	return { message, truncated };
}

export function hasTemplate(toolName: string): boolean {
	return toolName in ALLOWLISTED_ARGS;
}
