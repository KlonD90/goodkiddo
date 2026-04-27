import { randomUUID } from "node:crypto";
import type { WorkspaceBackend } from "../backends/types";
import type {
	BackendExecutionRequest,
	SandboxBackend,
	SandboxBackendExecutionResult,
} from "../sandbox/types";
import {
	type ExecutionPolicy,
	prepareExecuteScript,
	prepareExecuteWorkspace,
	type SourceFile,
} from "./manifest";
import {
	type ExecuteResult,
	ExecuteResultSchema,
	type ExecuteScriptInput,
	type ExecuteWorkspaceInput,
	type OutputArtifact,
} from "./schemas";

const PII_PATTERNS: RegExp[] = [
	/\b\d{3}-\d{2}-\d{4}\b/,
	/\b(?:\+?\d{1,3}\s?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/,
	/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

export interface ExecutionOrchestratorOptions {
	backend: SandboxBackend;
	policy?: ExecutionPolicy;
}

function backendPathToRelativePath(filePath: string): string {
	return filePath.replace(/^\/+/, "");
}

function scanArtifacts(artifacts: OutputArtifact[]): OutputArtifact[] {
	return artifacts.map((artifact) => {
		const { content } = artifact;
		if (!content) return artifact;
		const flagged = PII_PATTERNS.some((pattern) => pattern.test(content));
		if (!flagged) return artifact;
		return {
			...artifact,
			status: "quarantined",
		};
	});
}

function normalizeBackendResult(
	result: SandboxBackendExecutionResult,
): ExecuteResult {
	return ExecuteResultSchema.parse({
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		outputArtifacts: scanArtifacts(result.outputArtifacts),
		durationMs: result.durationMs,
	});
}

async function readWorkspaceFiles(
	backend: WorkspaceBackend,
): Promise<SourceFile[]> {
	const infos = await backend.globInfo("**/*", "/");
	const filePaths = infos
		.filter((info) => !info.is_dir)
		.map((info) => info.path);
	const downloaded = await backend.downloadFiles(filePaths);

	return downloaded.flatMap((entry) => {
		if (!entry.content) return [];
		return [
			{
				path: backendPathToRelativePath(entry.path),
				content: new TextDecoder().decode(entry.content),
			},
		];
	});
}

export class ExecutionOrchestrator {
	private readonly backend: SandboxBackend;
	private readonly policy?: ExecutionPolicy;

	constructor(options: ExecutionOrchestratorOptions) {
		this.backend = options.backend;
		this.policy = options.policy;
	}

	async executeScript(input: ExecuteScriptInput): Promise<ExecuteResult> {
		const prepared = prepareExecuteScript(input, this.policy);
		return this.executePrepared(prepared);
	}

	async executeWorkspace(
		input: ExecuteWorkspaceInput,
		workspace: WorkspaceBackend,
	): Promise<ExecuteResult> {
		const files = await readWorkspaceFiles(workspace);
		const prepared = prepareExecuteWorkspace(input, files, this.policy);
		return this.executePrepared(prepared);
	}

	private async executePrepared(
		prepared: ReturnType<typeof prepareExecuteScript>,
	): Promise<ExecuteResult> {
		const request: BackendExecutionRequest = {
			sessionId: randomUUID(),
			manifest: prepared.manifest,
			files: prepared.files,
			projectionFiles: prepared.projectionFiles,
		};

		const session = await this.backend.createSession(request);
		try {
			const result = await this.backend.execute(session);
			return normalizeBackendResult(result);
		} finally {
			await this.backend.destroySession(session);
		}
	}
}
