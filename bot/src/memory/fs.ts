import type { BackendProtocol } from "deepagents";
import { fileDataToString } from "../utils/filesystem";

// Thin internal helpers around the workspace backend used by the memory
// subsystem. The agent itself uses the normal read_file/write_file/edit_file
// tools; these helpers are only for memory/* internals (bootstrap, index
// manager, lint, session loader) that manipulate files outside the tool layer.

export async function readOrEmpty(
	backend: BackendProtocol,
	path: string,
): Promise<string> {
	try {
		const data = await backend.readRaw(path);
		return fileDataToString(data);
	} catch {
		return "";
	}
}

export async function exists(
	backend: BackendProtocol,
	path: string,
): Promise<boolean> {
	try {
		await backend.readRaw(path);
		return true;
	} catch {
		return false;
	}
}

export async function overwrite(
	backend: BackendProtocol,
	path: string,
	content: string,
): Promise<void> {
	// uploadFiles is the only backend primitive that upserts — write() errors
	// when the path already exists, and edit() requires a known old_string.
	// It's optional on BackendProtocol, but every concrete backend we use
	// (SqliteStateBackend in particular) implements it.
	if (!backend.uploadFiles) {
		throw new Error(
			`Backend does not support uploadFiles; cannot write ${path}`,
		);
	}
	const results = await backend.uploadFiles([
		[path, new TextEncoder().encode(content)],
	]);
	const result = results[0];
	if (result?.error) {
		throw new Error(`Failed to write ${path}: ${result.error}`);
	}
}

export async function append(
	backend: BackendProtocol,
	path: string,
	suffix: string,
): Promise<void> {
	const existing = await readOrEmpty(backend, path);
	await overwrite(backend, path, existing + suffix);
}

export async function readModifiedAt(
	backend: BackendProtocol,
	path: string,
): Promise<string | null> {
	try {
		const data = await backend.readRaw(path);
		return data.modified_at ?? null;
	} catch {
		return null;
	}
}
