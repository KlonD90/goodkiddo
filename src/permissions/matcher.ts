import type { ArgumentMatcher, ArgumentOperator } from "./types";

function getByPath(value: unknown, dottedKey: string): unknown {
	const segments = dottedKey.split(".");
	let current: unknown = value;
	for (const segment of segments) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function globToRegex(pattern: string): RegExp {
	let result = "^";
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				result += ".*";
				i += 2;
				if (pattern[i] === "/") i += 1;
				continue;
			}
			result += "[^/]*";
			i += 1;
			continue;
		}
		if (char === "?") {
			result += "[^/]";
			i += 1;
			continue;
		}
		if ("\\^$.|+()[]{}".includes(char)) {
			result += `\\${char}`;
			i += 1;
			continue;
		}
		result += char;
		i += 1;
	}
	result += "$";
	return new RegExp(result);
}

function evaluateOperator(operator: ArgumentOperator, actual: unknown): boolean {
	if ("eq" in operator) {
		return deepEquals(operator.eq, actual);
	}
	if ("in" in operator) {
		return operator.in.some((candidate) => deepEquals(candidate, actual));
	}
	if ("glob" in operator) {
		if (typeof actual !== "string") return false;
		return globToRegex(operator.glob).test(actual);
	}
	if ("regex" in operator) {
		if (typeof actual !== "string") return false;
		try {
			return new RegExp(operator.regex).test(actual);
		} catch {
			return false;
		}
	}
	return false;
}

function deepEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((item, idx) => deepEquals(item, b[idx]));
	}
	const aObj = a as Record<string, unknown>;
	const bObj = b as Record<string, unknown>;
	const keys = Object.keys(aObj);
	if (keys.length !== Object.keys(bObj).length) return false;
	return keys.every((key) => deepEquals(aObj[key], bObj[key]));
}

export function matchesArguments(
	matcher: ArgumentMatcher | null,
	args: unknown,
): boolean {
	if (matcher === null) return true;
	for (const [dottedKey, operator] of Object.entries(matcher)) {
		const actual = getByPath(args, dottedKey);
		if (!evaluateOperator(operator, actual)) return false;
	}
	return true;
}

export function normalizeMatcher(
	matcher: ArgumentMatcher | null,
): string | null {
	if (matcher === null) return null;
	const sortedKeys = Object.keys(matcher).sort();
	const normalized: Record<string, ArgumentOperator> = {};
	for (const key of sortedKeys) normalized[key] = matcher[key];
	return JSON.stringify(normalized);
}
