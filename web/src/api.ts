export interface FsEntry {
	path: string;
	is_dir: boolean;
	size: number;
	modified_at: string;
}

export interface BootPayload {
	bearer: string;
	scopePath: string;
	scopeKind: "root" | "dir" | "file";
	initialPath: string;
	linkUuid: string;
}

export interface PreviewResponse {
	path: string;
	size: number;
	mime: string;
	content_base64?: string;
	too_large?: boolean;
}

export interface StatResponse {
	path: string;
	is_dir: boolean;
	size: number;
	mime?: string | null;
	modified_at?: string;
	child_count?: number;
}

function readBoot(): BootPayload {
	const boot = (window as unknown as { __FS_BOOT?: BootPayload }).__FS_BOOT;
	if (!boot) throw new Error("Boot payload missing");
	return boot;
}

export const boot = readBoot();

async function post<T>(route: string, body: unknown): Promise<T> {
	const response = await fetch(`/api/fs/${route}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${boot.bearer}`,
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		let detail: { error?: string } = {};
		try {
			detail = await response.json();
		} catch {}
		throw new Error(detail.error ?? `http_${response.status}`);
	}
	return (await response.json()) as T;
}

export async function listDirectory(
	path: string,
): Promise<{ path: string; entries: FsEntry[] }> {
	return post("ls", { path });
}

export async function previewFile(path: string): Promise<PreviewResponse> {
	return post("preview", { path });
}

export async function statPath(path: string): Promise<StatResponse> {
	return post("stat", { path });
}

export function downloadUrl(path: string): string {
	const query = new URLSearchParams({ path });
	return `/${boot.linkUuid}/_dl?${query.toString()}`;
}

export function parentDir(path: string): string {
	if (path === "/" || path === "") return "/";
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx <= 0 ? "/" : `${trimmed.slice(0, idx)}/`;
}

export function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const idx = trimmed.lastIndexOf("/");
	return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
