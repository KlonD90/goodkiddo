import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type {
	ImageUnderstandInput,
	ImageUnderstandOutput,
	ImageUnderstandingProvider,
} from "./types";

const TOOL_NAME = "understand_image";
const SERVER_NAME = "minimax";

export interface McpToolClient {
	invokeUnderstandImage(args: {
		prompt: string;
		image_url: string;
	}): Promise<unknown>;
	close(): Promise<void>;
}

export interface MinimaxImageUnderstandingOptions {
	apiKey: string;
	apiHost: string;
	toolClientFactory?: () => Promise<McpToolClient>;
}

async function defaultToolClientFactory(
	apiKey: string,
	apiHost: string,
): Promise<McpToolClient> {
	const client = new MultiServerMCPClient({
		mcpServers: {
			[SERVER_NAME]: {
				transport: "stdio",
				command: "uvx",
				args: ["minimax-coding-plan-mcp", "-y"],
				env: { MINIMAX_API_KEY: apiKey, MINIMAX_API_HOST: apiHost },
			},
		},
	});

	const tools = await client.getTools();
	const tool = tools.find(
		(candidate) =>
			candidate.name === TOOL_NAME || candidate.name.endsWith(`__${TOOL_NAME}`),
	);
	if (!tool) {
		await client.close();
		throw new Error(
			`MiniMax MCP did not expose ${TOOL_NAME}. Available tools: ${tools
				.map((candidate) => candidate.name)
				.join(", ") || "<none>"}`,
		);
	}

	return {
		invokeUnderstandImage: async (args) =>
			tool.invoke(args as Record<string, unknown>),
		close: () => client.close(),
	};
}

function normalizeMcpResponse(response: unknown): string {
	if (typeof response === "string") {
		return response;
	}
	if (Array.isArray(response)) {
		const parts: string[] = [];
		for (const block of response) {
			if (
				block !== null &&
				typeof block === "object" &&
				"type" in block &&
				(block as { type: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				parts.push((block as { text: string }).text);
			}
		}
		if (parts.length > 0) {
			return parts.join("\n");
		}
	}
	return JSON.stringify(response);
}

export function createMinimaxImageUnderstanding(
	options: MinimaxImageUnderstandingOptions,
): ImageUnderstandingProvider {
	const factory =
		options.toolClientFactory ??
		(() => defaultToolClientFactory(options.apiKey, options.apiHost));
	let clientPromise: Promise<McpToolClient> | null = null;

	const ensureClient = (): Promise<McpToolClient> => {
		if (clientPromise === null) {
			clientPromise = factory().catch((error) => {
				clientPromise = null;
				throw error;
			});
		}
		return clientPromise;
	};

	return {
		async understand(input: ImageUnderstandInput): Promise<ImageUnderstandOutput> {
			const client = await ensureClient();
			const dir = mkdtempSync(join(tmpdir(), "top-fedder-minimax-"));
			const filePath = join(dir, `image.${input.extension}`);
			writeFileSync(filePath, input.bytes);
			try {
				const response = await client.invokeUnderstandImage({
					prompt: input.prompt,
					image_url: filePath,
				});
				return { text: normalizeMcpResponse(response) };
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		async close(): Promise<void> {
			if (clientPromise === null) return;
			const pending = clientPromise;
			clientPromise = null;
			try {
				const client = await pending;
				await client.close();
			} catch {
				// Swallow close errors; nothing actionable for the caller.
			}
		},
	};
}
