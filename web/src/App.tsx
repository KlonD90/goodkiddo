import {
	Alert,
	Badge,
	Box,
	Button,
	Group,
	Image,
	Loader,
	ScrollArea,
	Stack,
	Text,
} from "@mantine/core";
import {
	IconAlertCircle,
	IconDownload,
	IconFile,
	IconFileText,
	IconFileTypePdf,
	IconFolder,
	IconFolderOpen,
	IconHome,
	IconPhoto,
} from "@tabler/icons-react";
import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type BootPayload,
	downloadUrl,
	type FsEntry,
	listDirectory,
	type PreviewResponse,
	previewFile,
	readBoot,
	statPath,
} from "./api";
import {
	basename,
	buildBreadcrumbs,
	isDirPath,
	isWithinScope,
	parentDir,
	resolveRelativePath,
} from "./paths";
import { decodeBase64Utf8 } from "./text";

function Workspace() {
	const [boot, setBoot] = useState<BootPayload | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		readBoot()
			.then(setBoot)
			.catch((e) => setError(e instanceof Error ? e.message : String(e)));
	}, []);

	if (error) {
		return (
			<div className="fs-boot-state">
				<Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
					Failed to load workspace. The link may have expired.
				</Alert>
			</div>
		);
	}

	if (!boot) {
		return (
			<div className="fs-boot-state">
				<Loader size="sm" />
				<Text size="sm" c="dimmed">
					Loading workspace
				</Text>
			</div>
		);
	}

	return <WorkspaceApp boot={boot} />;
}

const EXT_TO_LANG: Record<string, string> = {
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".ts": "typescript",
	".tsx": "typescript",
	".py": "python",
	".rb": "ruby",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".kt": "kotlin",
	".swift": "swift",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".hpp": "cpp",
	".cs": "csharp",
	".php": "php",
	".lua": "lua",
	".sh": "bash",
	".bash": "bash",
	".zsh": "bash",
	".fish": "bash",
	".sql": "sql",
	".json": "json",
	".jsonc": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "ini",
	".ini": "ini",
	".xml": "xml",
	".html": "xml",
	".htm": "xml",
	".css": "css",
	".scss": "scss",
	".less": "less",
	".dockerfile": "dockerfile",
	".env": "bash",
	".gitignore": "bash",
};

function detectLanguage(filePath: string): string | null {
	const lower = filePath.toLowerCase();
	const dot = lower.lastIndexOf(".");
	if (dot === -1) {
		const base = lower.slice(lower.lastIndexOf("/") + 1);
		if (base === "dockerfile") return "dockerfile";
		if (base === "makefile") return "makefile";
		return null;
	}
	return EXT_TO_LANG[lower.slice(dot)] ?? null;
}

function highlightCode(code: string, language: string | null): string {
	if (language && hljs.getLanguage(language)) {
		try {
			return hljs.highlight(code, { language, ignoreIllegals: true }).value;
		} catch {
			/* fall through */
		}
	}
	try {
		return hljs.highlightAuto(code).value;
	} catch {
		return escapeHtml(code);
	}
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

const md = new MarkdownIt({
	html: false,
	linkify: true,
	breaks: false,
	highlight(str, lang) {
		const language = lang && hljs.getLanguage(lang) ? lang : null;
		const highlighted = highlightCode(str, language);
		return `<pre><code class="hljs language-${language ?? "plaintext"}">${highlighted}</code></pre>`;
	},
});

// Disable autolinking of bare hostnames (e.g. "MEMORY.md" being treated as a link
// because .md is Moldova's TLD). Real http:// URLs still get linkified.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

// GitHub-style heading anchors: `# Title` becomes `<h1 id="title"><a href="#title" class="fs-anchor">#</a>Title</h1>`.
md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
	const token = tokens[idx];
	const inline = tokens[idx + 1];
	const text = inline?.children
		? inline.children
				.filter(
					(child) => child.type === "text" || child.type === "code_inline",
				)
				.map((child) => child.content)
				.join("")
		: (inline?.content ?? "");
	const id = slugify(text);
	if (id) token.attrSet("id", id);
	const anchor = id
		? `<a class="fs-anchor" href="#${id}" aria-label="Link to this section">#</a>`
		: "";
	return `${self.renderToken(tokens, idx, options)}${anchor}`;
};

function isCodeMime(mime: string): boolean {
	if (mime.startsWith("text/")) return true;
	return (
		mime === "application/json" ||
		mime === "application/xml" ||
		mime === "application/javascript" ||
		mime === "application/x-php"
	);
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function updateUrl(path: string, linkUuid: string): void {
	const params = new URLSearchParams({ uuid: linkUuid });
	if (path !== "/") params.set("path", path);
	const urlPath = `/fs/?${params.toString()}`;
	history.replaceState(null, "", urlPath);
}

function formatScopeKind(kind: BootPayload["scopeKind"]): string {
	if (kind === "root") return "Root";
	if (kind === "dir") return "Folder";
	return "File";
}

function formatEntryMeta(entry: FsEntry): string {
	return entry.is_dir ? "Folder" : formatSize(entry.size);
}

function entryClassName(entry: FsEntry, active: boolean): string {
	const parts = ["fs-entry"];
	if (entry.is_dir) parts.push("fs-entry-dir");
	if (active) parts.push("fs-entry-active");
	return parts.join(" ");
}

function EntryIcon({ entry }: { entry: FsEntry }) {
	const lower = entry.path.toLowerCase();
	if (entry.is_dir) return <IconFolder size={18} stroke={1.9} />;
	if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) {
		return <IconPhoto size={18} stroke={1.9} />;
	}
	if (lower.endsWith(".pdf")) return <IconFileTypePdf size={18} stroke={1.9} />;
	if (isCodeMime(detectMimeTypeFromPath(lower))) {
		return <IconFileText size={18} stroke={1.9} />;
	}
	return <IconFile size={18} stroke={1.9} />;
}

function detectMimeTypeFromPath(path: string): string {
	if (path.endsWith(".md")) return "text/markdown";
	if (path.endsWith(".txt")) return "text/plain";
	if (path.endsWith(".json")) return "application/json";
	if (path.endsWith(".xml")) return "application/xml";
	if (path.endsWith(".js") || path.endsWith(".mjs")) {
		return "application/javascript";
	}
	return detectLanguage(path) ? "text/plain" : "application/octet-stream";
}

interface PreviewProps {
	preview: PreviewResponse;
	currentFile: string;
	canNavigate: (path: string) => boolean;
	onNavigate: (path: string) => void | Promise<void>;
}

function FilePreview({
	preview,
	currentFile,
	canNavigate,
	onNavigate,
}: PreviewProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const node = containerRef.current;
		if (!node) return;
		const handler = (event: MouseEvent) => {
			const target = (event.target as HTMLElement | null)?.closest("a");
			if (!target) return;
			const href = target.getAttribute("href");
			if (!href) return;
			const resolved = resolveRelativePath(currentFile, href);
			if (!resolved) return;
			event.preventDefault();
			if (!canNavigate(resolved)) return;
			void onNavigate(resolved);
		};
		node.addEventListener("click", handler);
		return () => node.removeEventListener("click", handler);
	}, [currentFile, canNavigate, onNavigate]);

	if (preview.too_large) {
		return (
			<Alert
				icon={<IconAlertCircle size={16} />}
				color="yellow"
				variant="light"
			>
				File is too large to preview ({formatSize(preview.size)}). Use Download
				to retrieve it.
			</Alert>
		);
	}

	const b64 = preview.content_base64 ?? "";

	if (preview.mime === "text/markdown" || currentFile.endsWith(".md")) {
		const text = decodeBase64Utf8(b64);
		const html = md.render(text);
		return (
			<div
				ref={containerRef}
				className="markdown"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via markdown-it with html:false
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		);
	}

	if (preview.mime.startsWith("image/")) {
		return (
			<Image
				src={`data:${preview.mime};base64,${b64}`}
				alt={preview.path}
				fit="contain"
				className="fs-image-preview"
			/>
		);
	}

	if (preview.mime === "application/pdf") {
		return (
			<iframe
				title={preview.path}
				src={`data:${preview.mime};base64,${b64}`}
				className="fs-pdf-preview"
			/>
		);
	}

	if (isCodeMime(preview.mime)) {
		const text = decodeBase64Utf8(b64);
		const language = detectLanguage(currentFile);
		const highlighted = highlightCode(text, language);
		return (
			<div className="fs-code-preview">
				<pre>
					<code
						className={`hljs language-${language ?? "plaintext"}`}
						// biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is escaped HTML
						dangerouslySetInnerHTML={{ __html: highlighted }}
					/>
				</pre>
			</div>
		);
	}

	return (
		<Alert icon={<IconAlertCircle size={16} />} color="gray" variant="light">
			Binary file ({formatSize(preview.size)}, {preview.mime}). Use Download to
			retrieve it.
		</Alert>
	);
}

export function WorkspaceApp({ boot }: { boot: BootPayload }) {
	const displayRoot =
		boot.scopeKind === "file" ? parentDir(boot.scopePath) : boot.scopePath;
	const [currentPath, setCurrentPath] = useState<string>(boot.initialPath);
	const [entries, setEntries] = useState<FsEntry[] | null>(null);
	const [preview, setPreview] = useState<PreviewResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadingPreview, setLoadingPreview] = useState(false);

	const isFileScope = boot.scopeKind === "file";

	const canNavigate = useCallback(
		(path: string) => {
			if (boot.scopeKind === "root") return true;
			if (boot.scopeKind === "file") return path === boot.scopePath;
			return isWithinScope(path, boot.scopePath);
		},
		[boot.scopeKind, boot.scopePath],
	);

	const loadDirectory = useCallback(async (dirPath: string) => {
		try {
			setError(null);
			setEntries(null);
			const result = await listDirectory(dirPath);
			setEntries(result.entries);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEntries([]);
		}
	}, []);

	const loadPreview = useCallback(async (filePath: string) => {
		try {
			setError(null);
			setLoadingPreview(true);
			const result = await previewFile(filePath);
			setPreview(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPreview(null);
		} finally {
			setLoadingPreview(false);
		}
	}, []);

	const goTo = useCallback(
		async (path: string, resolveKind = false) => {
			if (!canNavigate(path)) return;
			if (!resolveKind || isDirPath(path) || isFileScope) {
				setCurrentPath(path);
				return;
			}
			try {
				const stat = await statPath(path);
				if (!canNavigate(stat.path)) return;
				setCurrentPath(stat.path);
			} catch {
				setCurrentPath(path);
			}
		},
		[canNavigate, isFileScope],
	);

	useEffect(() => {
		updateUrl(currentPath, boot.linkUuid);
		if (isDirPath(currentPath)) {
			setPreview(null);
			setLoadingPreview(false);
			if (!isFileScope) void loadDirectory(currentPath);
		} else {
			void loadPreview(currentPath);
			if (!isFileScope) {
				const parent = parentDir(currentPath);
				void loadDirectory(parent);
			}
		}
	}, [currentPath, isFileScope, loadDirectory, loadPreview, boot.linkUuid]);

	const breadcrumbs = useMemo(
		() => buildBreadcrumbs(currentPath, displayRoot),
		[currentPath, displayRoot],
	);

	const sortedEntries = useMemo(() => {
		if (!entries) return null;
		return [...entries].sort((a, b) => {
			if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
			return basename(a.path).localeCompare(basename(b.path), undefined, {
				numeric: true,
				sensitivity: "base",
			});
		});
	}, [entries]);

	const showingFile = !isDirPath(currentPath);
	const currentName = basename(currentPath) || "Workspace";
	const currentDirectory = showingFile ? parentDir(currentPath) : currentPath;
	const visibleEntries = sortedEntries ?? [];

	return (
		<div className="fs-app">
			<header className="fs-page-header">
				<div>
					<p className="fs-eyebrow">GoodKiddo workspace</p>
					<h1>File system</h1>
				</div>
				<Group gap="xs" wrap="nowrap" className="fs-header-actions">
					<Badge className="fs-scope-badge" variant="light" tt="none">
						{formatScopeKind(boot.scopeKind)}
					</Badge>
					{showingFile && (
						<Button
							component="a"
							href={downloadUrl(currentPath, boot.linkUuid)}
							leftSection={<IconDownload size={16} stroke={2} />}
							className="fs-download-button"
						>
							Download
						</Button>
					)}
				</Group>
			</header>

			<section className="fs-window" aria-label="File browser">
				<div className="fs-window-bar">
					<div className="fs-window-dots" aria-hidden="true">
						<span />
						<span />
						<span />
					</div>
					<div className="fs-window-title">
						<IconFolderOpen size={16} stroke={2} />
						<span>{boot.scopePath}</span>
					</div>
				</div>

				<div className={isFileScope ? "fs-layout fs-layout-file" : "fs-layout"}>
					{!isFileScope && (
						<aside className="fs-sidebar">
							<div className="fs-sidebar-head">
								<Text className="fs-panel-label">Index</Text>
								<Text className="fs-sidebar-path">{currentDirectory}</Text>
							</div>

							<nav className="fs-breadcrumbs" aria-label="Breadcrumbs">
								{breadcrumbs.map((crumb, index) => {
									const isLast = index === breadcrumbs.length - 1;
									return (
										<Box
											key={crumb.path}
											component="button"
											type="button"
											className="fs-breadcrumb-item"
											title={crumb.path}
											disabled={isLast}
											onClick={() => void goTo(crumb.path)}
										>
											{index === 0 ? (
												<IconHome size={14} stroke={2} />
											) : (
												<span className="fs-crumb-separator">/</span>
											)}
											<span>{crumb.label}</span>
										</Box>
									);
								})}
							</nav>

							<ScrollArea className="fs-entry-scroll" type="auto">
								{sortedEntries === null ? (
									<div className="fs-list-state">
										<Loader size="sm" />
									</div>
								) : sortedEntries.length === 0 ? (
									<div className="fs-list-state">
										<Text size="sm" c="dimmed">
											Empty directory
										</Text>
									</div>
								) : (
									<div className="fs-entry-list">
										{visibleEntries.map((entry) => {
											const name = basename(entry.path) || entry.path;
											const active = entry.path === currentPath;
											return (
												<button
													key={entry.path}
													type="button"
													className={entryClassName(entry, active)}
													title={entry.path}
													onClick={() => void goTo(entry.path)}
												>
													<span className="fs-entry-icon">
														<EntryIcon entry={entry} />
													</span>
													<span className="fs-entry-copy">
														<span className="fs-entry-name">{name}</span>
														<span className="fs-entry-meta">
															{formatEntryMeta(entry)}
														</span>
													</span>
												</button>
											);
										})}
									</div>
								)}
							</ScrollArea>
						</aside>
					)}

					<main className="fs-main">
						{error && (
							<Alert
								icon={<IconAlertCircle size={16} />}
								color="red"
								variant="light"
							>
								{error}
							</Alert>
						)}

						<div className="fs-preview-head">
							<div>
								<Text className="fs-panel-label">
									{showingFile ? "Preview" : "Directory"}
								</Text>
								<h2>{currentName}</h2>
							</div>
							<div className="fs-preview-meta">
								<Text>{currentPath}</Text>
								{preview && (
									<Text>
										{formatSize(preview.size)} / {preview.mime}
									</Text>
								)}
							</div>
						</div>

						<div className="fs-preview">
							{showingFile ? (
								loadingPreview ? (
									<div className="fs-preview-loading">
										<Loader />
									</div>
								) : preview ? (
									<FilePreview
										preview={preview}
										currentFile={currentPath}
										canNavigate={canNavigate}
										onNavigate={(path) => goTo(path, true)}
									/>
								) : (
									<Text c="dimmed">No preview available.</Text>
								)
							) : (
								<Stack gap="xs" className="fs-empty-state">
									<IconFolderOpen size={34} stroke={1.7} />
									<Text fw={600}>{currentDirectory}</Text>
									<Text size="sm" c="dimmed">
										{visibleEntries.length === 0
											? "Empty directory"
											: `${visibleEntries.length} item${
													visibleEntries.length === 1 ? "" : "s"
												}`}
									</Text>
								</Stack>
							)}
						</div>
					</main>
				</div>
			</section>
		</div>
	);
}

export { Workspace as App };
