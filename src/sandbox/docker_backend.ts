import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { SourceFile } from "../execution/manifest";
import { manifestToJson } from "../execution/manifest";
import type {
	BackendExecutionRequest,
	BackendSession,
	SandboxBackend,
	SandboxBackendCapabilities,
	SandboxBackendExecutionResult,
} from "./types";

export interface DockerBackendOptions {
	image?: string;
	repoRoot?: string;
	allowUnsafeNetwork?: boolean;
	timeoutMs?: number;
}

async function writeSourceFile(
	baseDir: string,
	file: SourceFile,
): Promise<void> {
	const targetPath = join(baseDir, file.path);
	await mkdir(dirname(targetPath), { recursive: true });
	await writeFile(targetPath, file.content, "utf8");
}

async function listFilesRecursively(rootDir: string): Promise<string[]> {
	const entries = await readdir(rootDir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFilesRecursively(fullPath)));
			continue;
		}
		files.push(fullPath);
	}

	return files;
}

function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Command timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});

		child.on("close", (code) => {
			clearTimeout(timeout);
			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
			});
		});
	});
}

export class DockerBackend implements SandboxBackend {
	private readonly image: string;
	private readonly repoRoot: string;
	private readonly allowUnsafeNetwork: boolean;
	private readonly timeoutMs: number;

	constructor(options: DockerBackendOptions = {}) {
		this.image = options.image ?? "top-fedder-dev:latest";
		this.repoRoot = options.repoRoot ?? process.cwd();
		this.allowUnsafeNetwork = options.allowUnsafeNetwork ?? false;
		this.timeoutMs = options.timeoutMs ?? 60_000;
	}

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
		const workspaceDir = await mkdtemp(join(tmpdir(), "top-fedder-docker-"));
		const execDir = join(workspaceDir, "exec");
		const inputDir = join(workspaceDir, "input");
		const outputDir = join(workspaceDir, "output");

		await mkdir(execDir, { recursive: true });
		await mkdir(inputDir, { recursive: true });
		await mkdir(outputDir, { recursive: true });

		for (const file of request.files) {
			await writeSourceFile(execDir, file);
		}

		for (const file of request.projectionFiles) {
			await writeSourceFile(inputDir, file);
		}

		await writeFile(
			join(execDir, "manifest.json"),
			manifestToJson(request.manifest),
			"utf8",
		);

		return {
			id: request.sessionId,
			manifest: request.manifest,
			workspaceDir,
			sessionMode: request.manifest.sessionMode,
		};
	}

	async execute(
		session: BackendSession,
	): Promise<SandboxBackendExecutionResult> {
		if (
			session.manifest.requiresNetwork &&
			!this.allowUnsafeNetwork &&
			!this.capabilities().supportsNetworkProxy
		) {
			throw new Error(
				"Docker backend does not enforce network allowlisting. Set allowUnsafeNetwork to true for local development only.",
			);
		}

		await access(this.repoRoot, constants.R_OK);
		const startedAt = Date.now();
		const args = [
			"run",
			"--rm",
			"-v",
			`${this.repoRoot}:/app:ro`,
			"-v",
			`${session.workspaceDir}:/workspace`,
		];

		if (!session.manifest.requiresNetwork) {
			args.push("--network", "none");
		}

		args.push(
			this.image,
			"bun",
			"/app/src/guest/runner.ts",
			"/workspace/exec/manifest.json",
		);

		const processResult = await runCommand("docker", args, this.timeoutMs);
		const durationMs = Date.now() - startedAt;
		const outputDir = join(session.workspaceDir, "output");
		const stdout = await readFile(join(outputDir, "stdout.txt"), "utf8").catch(
			() => processResult.stdout,
		);
		const stderr = await readFile(join(outputDir, "stderr.txt"), "utf8").catch(
			() => processResult.stderr,
		);
		const artifactPaths = await listFilesRecursively(outputDir).catch(() => []);
		const outputArtifacts = await Promise.all(
			artifactPaths
				.filter(
					(filePath) =>
						!["stdout.txt", "stderr.txt", "exit.json"].includes(
							filePath.split("/").pop() ?? "",
						),
				)
				.map(async (filePath) => ({
					path: relative(outputDir, filePath),
					type: "file" as const,
					status: "active" as const,
					content: await readFile(filePath, "utf8").catch(() => undefined),
				})),
		);

		const exitJson = await readFile(join(outputDir, "exit.json"), "utf8").catch(
			() => JSON.stringify({ exitCode: processResult.exitCode }),
		);
		let exitCode = processResult.exitCode;

		try {
			const parsed = JSON.parse(exitJson) as { exitCode?: number };
			if (typeof parsed.exitCode === "number") {
				exitCode = parsed.exitCode;
			}
		} catch {
			// Keep process exit code fallback.
		}

		return {
			exitCode,
			stdout,
			stderr,
			outputArtifacts,
			durationMs,
		};
	}

	async destroySession(session: BackendSession): Promise<void> {
		await rm(session.workspaceDir, { recursive: true, force: true });
	}
}
