import { appendFileSync } from "node:fs";
import { maskSecret } from "../config";
import type { PermissionDecision } from "./types";

export interface AuditLogger {
	record(entry: AuditEntry): void;
}

export type AuditEntry = {
	userId: string;
	toolName: string;
	args: unknown;
	decision: PermissionDecision;
	ruleId: number | "default-allow" | "default-ask" | "blocked-unknown-user";
	outcome: "allowed" | "denied-by-policy" | "denied-by-user" | "blocked";
	timestamp?: number;
};

const LIKELY_SECRET_KEYS = ["token", "apiKey", "api_key", "secret", "password"];

function redactForAudit(value: unknown): unknown {
	if (value === null) return null;
	if (typeof value === "string") {
		return value.length > 64
			? `${value.slice(0, 32)}…(${value.length}b)`
			: value;
	}
	if (Array.isArray(value)) return value.map(redactForAudit);
	if (typeof value === "object") {
		const input = value as Record<string, unknown>;
		const output: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(input)) {
			if (LIKELY_SECRET_KEYS.includes(key) && typeof child === "string") {
				output[key] = maskSecret(child);
				continue;
			}
			output[key] = redactForAudit(child);
		}
		return output;
	}
	return value;
}

export class FileAuditLogger implements AuditLogger {
	constructor(private readonly filePath: string) {}

	record(entry: AuditEntry): void {
		const payload = {
			...entry,
			args: redactForAudit(entry.args),
			timestamp: entry.timestamp ?? Date.now(),
		};
		appendFileSync(this.filePath, `${JSON.stringify(payload)}\n`);
	}
}

export class NoopAuditLogger implements AuditLogger {
	record(): void {}
}
