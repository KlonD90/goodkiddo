import type { BackendProtocol } from "deepagents";

export const INCOMING_DIR = "/incoming";

type UploadingBackend = BackendProtocol & {
	uploadFiles(
		files: Array<[string, Uint8Array]>,
	): Promise<Array<{ path: string; error: string | null }>>;
};

function hasUploadFiles(
	backend: BackendProtocol,
): backend is UploadingBackend {
	return (
		"uploadFiles" in backend && typeof backend.uploadFiles === "function"
	);
}

function normalizeExtension(extension: string): string {
	const stripped = extension.startsWith(".") ? extension.slice(1) : extension;
	const lowercase = stripped.toLowerCase();
	if (!/^[a-z0-9]+$/u.test(lowercase)) {
		throw new Error(
			`Invalid attachment extension '${extension}': only [a-z0-9] are allowed`,
		);
	}
	return lowercase;
}

function makeRandomSegment(): string {
	let segment = "";
	while (segment.length < 6) {
		segment += Math.random().toString(36).slice(2);
	}
	return segment.slice(0, 6);
}

export interface SaveIncomingAttachmentInput {
	backend: BackendProtocol;
	bytes: Uint8Array;
	extension: string;
}

export interface SaveIncomingAttachmentResult {
	vfsPath: string;
}

export async function saveIncomingAttachment(
	input: SaveIncomingAttachmentInput,
): Promise<SaveIncomingAttachmentResult> {
	if (!hasUploadFiles(input.backend)) {
		throw new Error(
			"Backend does not implement uploadFiles; cannot persist binary attachments.",
		);
	}

	const ext = normalizeExtension(input.extension);
	const vfsPath = `${INCOMING_DIR}/${Date.now()}-${makeRandomSegment()}.${ext}`;

	const [response] = await input.backend.uploadFiles([[vfsPath, input.bytes]]);
	if (response?.error) {
		throw new Error(
			`Failed to save attachment to ${vfsPath}: ${response.error}`,
		);
	}

	return { vfsPath };
}
