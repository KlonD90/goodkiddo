export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_VALUES: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function resolveThreshold(): number {
	const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
	if (raw in LEVEL_VALUES) return LEVEL_VALUES[raw as LogLevel];
	return LEVEL_VALUES.info;
}

let threshold = resolveThreshold();

export function setLogLevel(level: LogLevel): void {
	threshold = LEVEL_VALUES[level];
}

export function getLogLevel(): LogLevel {
	const entry = (Object.entries(LEVEL_VALUES) as Array<[LogLevel, number]>).find(
		([, v]) => v === threshold,
	);
	return entry ? entry[0] : "info";
}

function formatValue(v: unknown): string {
	if (v === undefined) return "undefined";
	if (v === null) return "null";
	if (v instanceof Error) {
		return JSON.stringify({ message: v.message, stack: v.stack });
	}
	if (typeof v === "string") {
		if (v === "" || /[\s"=]/.test(v)) return JSON.stringify(v);
		return v;
	}
	if (
		typeof v === "number" ||
		typeof v === "boolean" ||
		typeof v === "bigint"
	) {
		return String(v);
	}
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

function formatFields(fields: Record<string, unknown> | undefined): string {
	if (!fields) return "";
	const keys = Object.keys(fields);
	if (keys.length === 0) return "";
	return ` ${keys.map((k) => `${k}=${formatValue(fields[k])}`).join(" ")}`;
}

function emit(
	level: LogLevel,
	service: string,
	msg: string,
	fields?: Record<string, unknown>,
): void {
	if (LEVEL_VALUES[level] < threshold) return;
	const ts = new Date().toISOString();
	const line = `${ts} ${level.toUpperCase().padEnd(5)} [${service}] ${msg}${formatFields(fields)}\n`;
	const stream = level === "error" ? process.stderr : process.stdout;
	stream.write(line);
}

export interface Logger {
	debug(msg: string, fields?: Record<string, unknown>): void;
	info(msg: string, fields?: Record<string, unknown>): void;
	warn(msg: string, fields?: Record<string, unknown>): void;
	error(msg: string, fields?: Record<string, unknown>): void;
	child(subService: string): Logger;
}

export function createLogger(service: string): Logger {
	return {
		debug: (msg, fields) => emit("debug", service, msg, fields),
		info: (msg, fields) => emit("info", service, msg, fields),
		warn: (msg, fields) => emit("warn", service, msg, fields),
		error: (msg, fields) => emit("error", service, msg, fields),
		child: (sub) => createLogger(`${service}.${sub}`),
	};
}
