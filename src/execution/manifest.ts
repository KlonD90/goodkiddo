import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import {
	type DataRequirement,
	type ExecuteScriptInput,
	ExecuteScriptInputSchema,
	type ExecuteWorkspaceInput,
	ExecuteWorkspaceInputSchema,
	type ExpectedOutput,
	type InternalExecutionManifest,
	InternalExecutionManifestSchema,
	type Runtime,
	type SessionMode,
	type TaskType,
} from "./schemas";

export type SourceFile = {
	path: string;
	content: string;
};

export type PreparedExecution = {
	manifest: InternalExecutionManifest;
	files: SourceFile[];
	projectionFiles: SourceFile[];
};

export interface ExecutionPolicy {
	allowedTaskTypes?: TaskType[];
	allowedRuntimeExtensions?: Partial<Record<Runtime, string[]>>;
}

const DEFAULT_TASK_TYPE: TaskType = "standard";
const DEFAULT_ALLOWED_TASK_TYPES: TaskType[] = ["standard", "browser", "heavy"];
const DEFAULT_RUNTIME_EXTENSIONS: Record<Runtime, string[]> = {
	python: [".py"],
	bun: [".ts", ".js", ".mjs"],
	shell: [".sh"],
	"agent-browser": [".sh"],
};

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function normalizeRelativePath(input: string): string {
	const raw = input.trim().replaceAll("\\", "/");
	if (!raw) throw new Error("Path cannot be empty");
	if (raw.startsWith("/"))
		throw new Error(`Absolute paths are not allowed: ${input}`);
	if (/^[A-Za-z]:\//.test(raw)) {
		throw new Error(`Windows-style absolute paths are not allowed: ${input}`);
	}

	const normalized = path.normalize(raw);
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		normalized.includes("/./") ||
		normalized.startsWith("./") ||
		normalized.includes("//")
	) {
		throw new Error(`Invalid relative path: ${input}`);
	}
	if (normalized.split("/").includes("..")) {
		throw new Error(`Path traversal is not allowed: ${input}`);
	}
	return normalized.replace(/^\/+/, "");
}

function dedupeAndNormalizeFiles(files: SourceFile[]): SourceFile[] {
	const seen = new Set<string>();
	return files.map((file) => {
		const normalizedPath = normalizeRelativePath(file.path);
		if (seen.has(normalizedPath)) {
			throw new Error(`Duplicate file path: ${normalizedPath}`);
		}
		seen.add(normalizedPath);
		return { path: normalizedPath, content: file.content };
	});
}

function normalizeExpectedOutputs(outputs: ExpectedOutput[]): ExpectedOutput[] {
	return outputs.map((output) => ({
		...output,
		path: normalizeRelativePath(output.path),
	}));
}

function resolveRequestedTaskType(
	runtime: Runtime,
	requested?: TaskType,
): TaskType {
	if (requested) return requested;
	return runtime === "agent-browser" ? "browser" : DEFAULT_TASK_TYPE;
}

function resolveGrantedTaskType(
	requestedTaskType: TaskType,
	allowedTaskTypes: TaskType[],
): TaskType {
	if (allowedTaskTypes.includes(requestedTaskType)) return requestedTaskType;
	return allowedTaskTypes[0] ?? DEFAULT_TASK_TYPE;
}

function resolveSessionMode(
	dataRequirements: DataRequirement[],
	networkDomains: string[],
): SessionMode {
	if (dataRequirements.length > 0 && networkDomains.length > 0) {
		throw new Error(
			"Execution requests cannot combine sensitive data access with network access",
		);
	}
	if (networkDomains.length > 0) return "networked-exec";
	return "isolated-data";
}

function assertRuntimeAllowed(
	runtime: Runtime,
	files: SourceFile[],
	allowedRuntimeExtensions: Record<Runtime, string[]>,
	entrypoint: string,
): void {
	if (runtime === "agent-browser" && entrypoint.length === 0) {
		throw new Error("agent-browser runtime requires an entrypoint");
	}

	const allowed = allowedRuntimeExtensions[runtime];
	const ext = path.extname(entrypoint);
	if (!allowed.includes(ext)) {
		throw new Error(
			`Runtime ${runtime} does not allow entrypoint extension ${ext || "<none>"}`,
		);
	}

	for (const file of files) {
		if (!file.path) throw new Error("File path cannot be empty");
	}
}

function normalizeNetworkDomains(networkDomains: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const domain of networkDomains) {
		const value = domain.trim().toLowerCase();
		if (!value) throw new Error("Network domains cannot be empty");
		if (seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}

	return normalized;
}

function buildManifest(params: {
	runtime: Runtime;
	entrypoint: string;
	args: string[];
	expectedOutputs: ExpectedOutput[];
	dataRequirements: DataRequirement[];
	networkDomains: string[];
	files: SourceFile[];
	requestedTaskType?: TaskType;
	policy?: ExecutionPolicy;
}): InternalExecutionManifest {
	const allowedTaskTypes =
		params.policy?.allowedTaskTypes ?? DEFAULT_ALLOWED_TASK_TYPES;
	const allowedRuntimeExtensions = {
		...DEFAULT_RUNTIME_EXTENSIONS,
		...params.policy?.allowedRuntimeExtensions,
	};
	const normalizedDomains = normalizeNetworkDomains(params.networkDomains);
	const sessionMode = resolveSessionMode(
		params.dataRequirements,
		normalizedDomains,
	);
	const requestedTaskType = resolveRequestedTaskType(
		params.runtime,
		params.requestedTaskType,
	);
	const grantedTaskType = resolveGrantedTaskType(
		requestedTaskType,
		allowedTaskTypes,
	);

	if (params.runtime === "agent-browser" && normalizedDomains.length === 0) {
		throw new Error(
			"agent-browser runtime requires at least one network domain",
		);
	}

	const normalizedEntrypoint = normalizeRelativePath(params.entrypoint);
	assertRuntimeAllowed(
		params.runtime,
		params.files,
		allowedRuntimeExtensions,
		normalizedEntrypoint,
	);

	const manifest = InternalExecutionManifestSchema.parse({
		entrypoint: normalizedEntrypoint,
		runtime: params.runtime,
		args: params.args,
		files: params.files.map((file) => ({
			path: file.path,
			hash: sha256(file.content),
		})),
		expectedOutputs: normalizeExpectedOutputs(params.expectedOutputs),
		dataRequirements: params.dataRequirements,
		requiresNetwork: normalizedDomains.length > 0,
		networkDomains: normalizedDomains,
		requestedTaskType,
		grantedTaskType,
		sessionMode,
	});

	return manifest;
}

export function prepareExecuteScript(
	input: ExecuteScriptInput,
	policy?: ExecutionPolicy,
): PreparedExecution {
	const parsed = ExecuteScriptInputSchema.parse(input);
	const sourceFiles = dedupeAndNormalizeFiles([
		{ path: parsed.filename, content: parsed.script },
		...parsed.supportFiles,
	]);

	const manifest = buildManifest({
		runtime: parsed.runtime,
		entrypoint: parsed.filename,
		args: parsed.args,
		expectedOutputs: parsed.expectedOutputs,
		dataRequirements: parsed.dataRequirements,
		networkDomains: parsed.networkDomains,
		files: sourceFiles,
		requestedTaskType: parsed.taskType,
		policy,
	});

	return {
		manifest,
		files: sourceFiles,
		projectionFiles: [],
	};
}

export function prepareExecuteWorkspace(
	input: ExecuteWorkspaceInput,
	workspaceFiles: SourceFile[],
	policy?: ExecutionPolicy,
): PreparedExecution {
	const parsed = ExecuteWorkspaceInputSchema.parse(input);
	const sourceFiles = dedupeAndNormalizeFiles(workspaceFiles);

	if (
		!sourceFiles.some(
			(file) => file.path === normalizeRelativePath(parsed.entrypoint),
		)
	) {
		throw new Error(`Entrypoint not found in workspace: ${parsed.entrypoint}`);
	}

	const manifest = buildManifest({
		runtime: parsed.runtime,
		entrypoint: parsed.entrypoint,
		args: parsed.args,
		expectedOutputs: parsed.expectedOutputs,
		dataRequirements: parsed.dataRequirements,
		networkDomains: parsed.networkDomains,
		files: sourceFiles,
		requestedTaskType: parsed.taskType,
		policy,
	});

	return {
		manifest,
		files: sourceFiles,
		projectionFiles: [],
	};
}

export function manifestToJson(manifest: InternalExecutionManifest): string {
	return JSON.stringify(manifest, null, 2);
}

export function validateInternalManifest(
	value: unknown,
): InternalExecutionManifest {
	return InternalExecutionManifestSchema.parse(value);
}
