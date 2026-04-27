import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateInternalManifest } from "../execution/manifest";

function resolveCommand(runtime: string, entrypoint: string, args: string[]) {
	switch (runtime) {
		case "python":
			return ["python3", entrypoint, ...args];
		case "bun":
			return ["bun", entrypoint, ...args];
		case "shell":
			return ["sh", entrypoint, ...args];
		case "agent-browser":
			return ["sh", entrypoint, ...args];
		default:
			throw new Error(`Unsupported runtime: ${runtime}`);
	}
}

async function ensureParentDir(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
}

async function run(): Promise<number> {
	const manifestPath = process.argv[2];
	if (!manifestPath) throw new Error("Manifest path is required");

	const manifest = validateInternalManifest(
		JSON.parse(await readFile(manifestPath, "utf8")),
	);
	const workspaceRoot = dirname(dirname(manifestPath));
	const outputDir = join(workspaceRoot, "output");
	const execDir = join(workspaceRoot, "exec");

	await mkdir(outputDir, { recursive: true });
	for (const expectedOutput of manifest.expectedOutputs) {
		await ensureParentDir(join(outputDir, expectedOutput.path));
	}

	const [command, ...args] = resolveCommand(
		manifest.runtime,
		manifest.entrypoint,
		manifest.args,
	);

	const result = await new Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
	}>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: execDir,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				TOP_FEDDER_EXEC_DIR: execDir,
				TOP_FEDDER_INPUT_DIR: join(workspaceRoot, "input"),
				TOP_FEDDER_OUTPUT_DIR: outputDir,
			},
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
			});
		});
	});

	await writeFile(join(outputDir, "stdout.txt"), result.stdout, "utf8");
	await writeFile(join(outputDir, "stderr.txt"), result.stderr, "utf8");
	await writeFile(
		join(outputDir, "exit.json"),
		JSON.stringify({ exitCode: result.exitCode }, null, 2),
		"utf8",
	);

	return result.exitCode;
}

run()
	.then((exitCode) => {
		process.exitCode = exitCode;
	})
	.catch(async (error) => {
		const message =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		const manifestPath = process.argv[2];
		if (manifestPath) {
			const workspaceRoot = dirname(dirname(manifestPath));
			const outputDir = join(workspaceRoot, "output");
			await mkdir(outputDir, { recursive: true });
			await writeFile(join(outputDir, "stdout.txt"), "", "utf8");
			await writeFile(join(outputDir, "stderr.txt"), message, "utf8");
			await writeFile(
				join(outputDir, "exit.json"),
				JSON.stringify({ exitCode: 1 }, null, 2),
				"utf8",
			);
		}
		process.exitCode = 1;
	});
