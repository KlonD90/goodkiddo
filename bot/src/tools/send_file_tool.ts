import { context, tool } from "langchain";
import { z } from "zod";
import type { WorkspaceBackend } from "../backends/types";
import { isDraftArtifactPath } from "../capabilities/prepared_followups/artifacts";
import type { OutboundChannel } from "../channels/outbound";
import { basenameFromPath, detectMimeType } from "../utils/filesystem.js";

export const SEND_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const SEND_FILE_MAX_CAPTION_LENGTH = 1024;

const SEND_FILE_TOOL_PROMPT = context`Send a file from the virtual filesystem to the user as an attachment.

Use this when the user asked for an artifact (report, generated file, scraped data, image, pdf, etc.)
and you want to deliver it directly through the channel the user arrived on (e.g. as a Telegram
document). The file must already exist in the virtual filesystem — write it first if needed.

Limits:
- One file per call.
- Maximum 20 MB per file.
- Optional caption is up to 1024 characters.

If the file is missing, too large, or delivery fails, an error string is returned so you can adapt.`;

function toBackendPath(filePath: string): string {
	return filePath.startsWith("/") ? filePath : `/${filePath}`;
}

export interface CreateSendFileToolOptions {
	workspace: WorkspaceBackend;
	outbound: OutboundChannel;
	callerId: string;
}

export function createSendFileTool(options: CreateSendFileToolOptions) {
	return tool(
		async ({ file_path, caption }: { file_path: string; caption?: string }) => {
			const resolvedPath = toBackendPath(file_path);
			if (isDraftArtifactPath(resolvedPath)) {
				return `Error: '${resolvedPath}' is an internal prepared follow-up draft and cannot be sent as a file.`;
			}

			if (
				caption !== undefined &&
				caption.length > SEND_FILE_MAX_CAPTION_LENGTH
			) {
				return `Error: caption is too long (${caption.length} chars). Maximum is ${SEND_FILE_MAX_CAPTION_LENGTH}.`;
			}

			const [downloaded] = await options.workspace.downloadFiles([
				resolvedPath,
			]);
			if (!downloaded) {
				return `Error: unexpected empty response while downloading '${resolvedPath}'.`;
			}
			if (downloaded.error) {
				if (downloaded.error === "file_not_found") {
					return `Error: file '${resolvedPath}' not found.`;
				}
				return `Error: ${downloaded.error}`;
			}
			if (!downloaded.content) {
				return `Error: file '${resolvedPath}' has no content.`;
			}

			const bytes = downloaded.content;
			if (bytes.length > SEND_FILE_MAX_BYTES) {
				return `Error: file '${resolvedPath}' is ${bytes.length} bytes, which exceeds the ${SEND_FILE_MAX_BYTES}-byte send limit. Split it or summarize before sending.`;
			}

			const mimeType =
				detectMimeType(resolvedPath) ?? "application/octet-stream";

			const result = await options.outbound.sendFile({
				callerId: options.callerId,
				path: resolvedPath,
				bytes,
				mimeType,
				caption,
			});

			if (!result.ok) {
				return `Error: delivery failed — ${result.error}`;
			}

			const filename = basenameFromPath(resolvedPath);
			return `Sent '${filename}' (${bytes.length} bytes, ${mimeType}) to the user.`;
		},
		{
			name: "send_file",
			description: SEND_FILE_TOOL_PROMPT,
			schema: z.object({
				file_path: z
					.string()
					.min(1)
					.describe("Absolute path of the file in the virtual filesystem."),
				caption: z
					.string()
					.max(SEND_FILE_MAX_CAPTION_LENGTH)
					.optional()
					.describe(
						"Optional short caption shown alongside the attachment. Write normal Markdown-ish text; the Telegram channel will render it safely.",
					),
			}),
		},
	);
}
