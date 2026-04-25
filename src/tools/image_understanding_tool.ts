import { context, tool } from "langchain";
import { z } from "zod";
import type { BackendProtocol } from "deepagents";
import type { ImageUnderstandingProvider } from "../capabilities/image/types";
import { INCOMING_DIR } from "../capabilities/incoming/save_attachment";

const TOOL_PROMPT = context`Analyze an image stored in your filesystem using an external vision model.

Use this when a user attaches an image and the system tells you the path. The tool returns a textual description; you can call it again with a different prompt to ask follow-up questions about the same image.

Always include relevant context from the conversation in the prompt — the vision model has no access to chat history, so tell it what the user is asking about and what kind of detail they need.`;

const PROMPT_DESCRIPTION =
	"The question or analysis request for the image. Include relevant conversation context (what the user is asking, what detail they need) since the vision model has no access to chat history.";

const IMAGE_PATH_DESCRIPTION = `Path to the image inside your filesystem, exactly as the system told you when the attachment arrived. Must be under ${INCOMING_DIR}/.`;

type DownloadableBackend = {
	downloadFiles(
		paths: string[],
	): Promise<
		Array<{ path: string; content: Uint8Array | null; error: string | null }>
	>;
};

function hasDownloadFiles(
	backend: BackendProtocol,
): backend is DownloadableBackend {
	if (
		"downloadFiles" in backend &&
		typeof (backend as { downloadFiles?: unknown }).downloadFiles === "function"
	) {
		return true;
	}
	return false;
}

function isUnderIncoming(rawPath: string): boolean {
	const trimmed = rawPath.trim();
	if (!trimmed.startsWith(`${INCOMING_DIR}/`)) return false;
	const segments = trimmed.split("/");
	for (const segment of segments) {
		if (segment === "..") return false;
	}
	return true;
}

function extractExtension(path: string): string {
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1 || lastDot === path.length - 1) return "bin";
	return path.slice(lastDot + 1).toLowerCase();
}

export interface CreateUnderstandImageToolOptions {
	provider: ImageUnderstandingProvider;
	backend: BackendProtocol;
}

export function createUnderstandImageTool(
	options: CreateUnderstandImageToolOptions,
) {
	return tool(
		async ({
			prompt,
			image_path,
		}: {
			prompt: string;
			image_path: string;
		}): Promise<string> => {
			if (!isUnderIncoming(image_path)) {
				return `Image analysis failed: image_path must be inside ${INCOMING_DIR}/, got '${image_path}'`;
			}

			if (!hasDownloadFiles(options.backend)) {
				return "Image analysis failed: workspace backend does not support binary download";
			}

			const [downloaded] = await options.backend.downloadFiles([image_path]);
			if (!downloaded || downloaded.error || !downloaded.content) {
				const reason = downloaded?.error ?? "unknown error";
				return `Image analysis failed: could not read '${image_path}' (${reason})`;
			}

			try {
				const result = await options.provider.understand({
					prompt,
					bytes: downloaded.content,
					extension: extractExtension(image_path),
				});
				return result.text;
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				return `Image analysis failed: ${message}`;
			}
		},
		{
			name: "understand_image",
			description: TOOL_PROMPT,
			schema: z.object({
				prompt: z.string().min(1).describe(PROMPT_DESCRIPTION),
				image_path: z.string().min(1).describe(IMAGE_PATH_DESCRIPTION),
			}),
		},
	);
}
