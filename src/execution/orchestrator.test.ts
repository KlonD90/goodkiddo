import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../backends/state_backend";
import type {
	BackendExecutionRequest,
	BackendSession,
	SandboxBackend,
	SandboxBackendCapabilities,
	SandboxBackendExecutionResult,
} from "../sandbox/types";
import { ExecutionOrchestrator } from "./orchestrator";

class FakeBackend implements SandboxBackend {
	public requests: BackendExecutionRequest[] = [];
	public destroyed: string[] = [];

	capabilities(): SandboxBackendCapabilities {
		return {
			isolation: "dev",
			supportsNetworkProxy: false,
			supportsRealMicrovm: false,
		};
	}

	async createSession(
		request: BackendExecutionRequest,
	): Promise<BackendSession> {
		this.requests.push(request);
		return {
			id: request.sessionId,
			manifest: request.manifest,
			workspaceDir: "/tmp/fake",
			sessionMode: request.manifest.sessionMode,
		};
	}

	async execute(
		_session: BackendSession,
	): Promise<SandboxBackendExecutionResult> {
		return {
			exitCode: 0,
			stdout: "ok",
			stderr: "",
			outputArtifacts: [
				{
					path: "result.txt",
					type: "file",
					status: "active",
					content: "hello",
				},
			],
			durationMs: 5,
		};
	}

	async destroySession(session: BackendSession): Promise<void> {
		this.destroyed.push(session.id);
	}
}

describe("ExecutionOrchestrator", () => {
	test("executes script through backend", async () => {
		const backend = new FakeBackend();
		const orchestrator = new ExecutionOrchestrator({ backend });

		const result = await orchestrator.executeScript({
			runtime: "python",
			script: "print('ok')",
			filename: "main.py",
			args: [],
			supportFiles: [],
			expectedOutputs: [],
			dataRequirements: [],
			networkDomains: [],
		});

		expect(result.exitCode).toBe(0);
		expect(backend.requests).toHaveLength(1);
		expect(backend.requests[0]?.manifest.sessionMode).toBe("isolated-data");
		expect(backend.destroyed).toHaveLength(1);
	});

	test("loads workspace files before execution", async () => {
		const backend = new FakeBackend();
		const orchestrator = new ExecutionOrchestrator({ backend });
		const workspace = new SqliteStateBackend({ dbPath: ":memory:" });
		workspace.write("/src/main.ts", "console.log('workspace');");

		const result = await orchestrator.executeWorkspace(
			{
				runtime: "bun",
				entrypoint: "src/main.ts",
				args: [],
				expectedOutputs: [],
				dataRequirements: [],
				networkDomains: [],
			},
			workspace,
		);

		expect(result.stdout).toBe("ok");
		expect(backend.requests[0]?.files[0]?.path).toBe("src/main.ts");
	});

	test("quarantines suspicious output", async () => {
		const backend = new FakeBackend();
		backend.execute = async () => ({
			exitCode: 0,
			stdout: "ok",
			stderr: "",
			outputArtifacts: [
				{
					path: "user.txt",
					type: "file",
					status: "active",
					content: "contact me at test@example.com",
				},
			],
			durationMs: 1,
		});

		const orchestrator = new ExecutionOrchestrator({ backend });
		const result = await orchestrator.executeScript({
			runtime: "python",
			script: "print('ok')",
			filename: "main.py",
			args: [],
			supportFiles: [],
			expectedOutputs: [],
			dataRequirements: [],
			networkDomains: [],
		});

		expect(result.outputArtifacts[0]?.status).toBe("quarantined");
	});
});
