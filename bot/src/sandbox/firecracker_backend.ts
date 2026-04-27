import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type {
	BackendExecutionRequest,
	BackendSession,
	SandboxBackend,
	SandboxBackendCapabilities,
	SandboxBackendExecutionResult,
} from "./types";

export interface FirecrackerBackendOptions {
	firecrackerBinaryPath?: string;
	jailerBinaryPath?: string;
}

async function assertLinuxKvmAvailable(): Promise<void> {
	if (process.platform !== "linux") {
		throw new Error("Firecracker backend requires Linux");
	}
	await access("/dev/kvm", constants.R_OK | constants.W_OK);
}

export class FirecrackerBackend implements SandboxBackend {
	private readonly firecrackerBinaryPath: string;
	private readonly jailerBinaryPath: string;

	constructor(options: FirecrackerBackendOptions = {}) {
		this.firecrackerBinaryPath =
			options.firecrackerBinaryPath ?? "/usr/local/bin/firecracker";
		this.jailerBinaryPath = options.jailerBinaryPath ?? "/usr/local/bin/jailer";
	}

	capabilities(): SandboxBackendCapabilities {
		return {
			isolation: "prod",
			supportsNetworkProxy: true,
			supportsRealMicrovm: true,
		};
	}

	async createSession(
		_request: BackendExecutionRequest,
	): Promise<BackendSession> {
		await assertLinuxKvmAvailable();
		await access(this.firecrackerBinaryPath, constants.X_OK);
		await access(this.jailerBinaryPath, constants.X_OK);
		throw new Error(
			"Firecracker backend session provisioning is not implemented yet in this environment",
		);
	}

	async execute(
		_session: BackendSession,
	): Promise<SandboxBackendExecutionResult> {
		throw new Error("Firecracker backend execution is not implemented yet");
	}

	async destroySession(_session: BackendSession): Promise<void> {
		return;
	}
}
