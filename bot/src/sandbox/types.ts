import type { SourceFile } from "../execution/manifest";
import type {
	InternalExecutionManifest,
	OutputArtifact,
	SessionMode,
} from "../execution/schemas";

export interface BackendExecutionRequest {
	sessionId: string;
	manifest: InternalExecutionManifest;
	files: SourceFile[];
	projectionFiles: SourceFile[];
}

export interface SandboxBackendCapabilities {
	isolation: "dev" | "prod";
	supportsNetworkProxy: boolean;
	supportsRealMicrovm: boolean;
}

export interface BackendSession {
	id: string;
	manifest: InternalExecutionManifest;
	workspaceDir: string;
	sessionMode: SessionMode;
}

export interface SandboxBackendExecutionResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	outputArtifacts: OutputArtifact[];
	durationMs: number;
}

export interface SandboxBackend {
	createSession(request: BackendExecutionRequest): Promise<BackendSession>;
	execute(session: BackendSession): Promise<SandboxBackendExecutionResult>;
	destroySession(session: BackendSession): Promise<void>;
	capabilities(): SandboxBackendCapabilities;
}
