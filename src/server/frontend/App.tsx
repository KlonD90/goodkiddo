import {
	Alert,
	AppShell,
	Badge,
	Breadcrumbs,
	Button,
	Code,
	Group,
	Image,
	Loader,
	NavLink,
	Paper,
	ScrollArea,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import {
	IconAlertCircle,
	IconChevronRight,
	IconDownload,
	IconFile,
	IconFolder,
	IconFolderOpen,
	IconHome,
} from "@tabler/icons-react";
import MarkdownIt from "markdown-it";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	basename,
	boot,
	downloadUrl,
	type FsEntry,
	listDirectory,
	type PreviewResponse,
	parentDir,
	previewFile,
} from "./api";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isDirPath(path: string): boolean {
	return path === "/" || path.endsWith("/");
}

function buildBreadcrumbs(
	currentPath: string,
	scopeRoot: string,
): { label: string; path: string }[] {
	const crumbs: { label: string; path: string }[] = [
		{ label: "root", path: scopeRoot },
	];
	if (currentPath === scopeRoot) return crumbs;
	const relative = currentPath.slice(scopeRoot.length).replace(/\/+$/, "");
	if (relative === "") return crumbs;
	const parts = relative.split("/");
	let acc = scopeRoot;
	parts.forEach((part, index) => {
		const isLast = index === parts.length - 1;
		acc += `${part}${isLast && !isDirPath(currentPath) ? "" : "/"}`;
		crumbs.push({ label: part, path: acc });
	});
	return crumbs;
}

function updateUrl(path: string): void {
	const urlPath = `/${boot.linkUuid}${path}`;
	history.replaceState(null, "", urlPath);
}

function resolveRelativePath(currentFile: string, href: string): string | null {
	if (!href || href.startsWith("#")) return null;
	if (
		href.startsWith("http://") ||
		href.startsWith("https://") ||
		href.startsWith("mailto:")
	) {
		return null;
	}
	const baseDir = parentDir(currentFile);
	let target: string;
	if (href.startsWith("/")) {
		target = href;
	} else {
		const stripped = href.replace(/^\.\//, "");
		target = `${baseDir}${stripped}`;
	}
	const segments: string[] = [];
	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			segments.pop();
			continue;
		}
		segments.push(part);
	}
	const normalized = `/${segments.join("/")}`;
	return normalized;
}

function isWithinScope(path: string, scopeRoot: string): boolean {
	if (scopeRoot === "/") return true;
	return path === scopeRoot || path.startsWith(scopeRoot);
}

interface PreviewProps {
	preview: PreviewResponse;
	currentFile: string;
	scopeRoot: string;
	onNavigate: (path: string) => void;
}

function FilePreview({
	preview,
	currentFile,
	scopeRoot,
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
			if (!isWithinScope(resolved, scopeRoot)) {
				event.preventDefault();
				return;
			}
			event.preventDefault();
			onNavigate(resolved);
		};
		node.addEventListener("click", handler);
		return () => node.removeEventListener("click", handler);
	}, [currentFile, scopeRoot, onNavigate]);

	if (preview.too_large) {
		return (
			<Alert
				icon={<IconAlertCircle size={16} />}
				color="yellow"
				variant="light"
			>
				File is too large to preview ({formatSize(preview.size)}). Use the
				Download button to retrieve it.
			</Alert>
		);
	}

	const b64 = preview.content_base64 ?? "";

	if (preview.mime === "text/markdown" || currentFile.endsWith(".md")) {
		const text = atob(b64);
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
				mah="80vh"
			/>
		);
	}

	if (preview.mime === "application/pdf") {
		return (
			<iframe
				title={preview.path}
				src={`data:${preview.mime};base64,${b64}`}
				style={{
					width: "100%",
					height: "80vh",
					border: "none",
					borderRadius: 6,
				}}
			/>
		);
	}

	if (
		preview.mime.startsWith("text/") ||
		preview.mime === "application/json" ||
		preview.mime === "application/xml" ||
		preview.mime === "application/javascript"
	) {
		const text = atob(b64);
		return (
			<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
				{text}
			</Code>
		);
	}

	return (
		<Alert icon={<IconAlertCircle size={16} />} color="gray" variant="light">
			Binary file ({formatSize(preview.size)}, {preview.mime}). Use the Download
			button to retrieve it.
		</Alert>
	);
}

export function App() {
	const scopeRoot =
		boot.scopeKind === "file" ? parentDir(boot.scopePath) : boot.scopePath;
	const [currentPath, setCurrentPath] = useState<string>(boot.initialPath);
	const [entries, setEntries] = useState<FsEntry[] | null>(null);
	const [preview, setPreview] = useState<PreviewResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadingPreview, setLoadingPreview] = useState(false);

	const isFileScope = boot.scopeKind === "file";

	const loadDirectory = useCallback(async (dirPath: string) => {
		try {
			setError(null);
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

	useEffect(() => {
		updateUrl(currentPath);
		if (isDirPath(currentPath)) {
			setPreview(null);
			if (!isFileScope) void loadDirectory(currentPath);
		} else {
			void loadPreview(currentPath);
			if (!isFileScope) {
				const parent = parentDir(currentPath);
				void loadDirectory(parent);
			}
		}
	}, [currentPath, isFileScope, loadDirectory, loadPreview]);

	const breadcrumbs = useMemo(
		() => buildBreadcrumbs(currentPath, scopeRoot),
		[currentPath, scopeRoot],
	);

	const sortedEntries = useMemo(() => {
		if (!entries) return null;
		return [...entries].sort((a, b) => {
			if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
			return basename(a.path).localeCompare(basename(b.path));
		});
	}, [entries]);

	const goTo = useCallback((path: string) => {
		setCurrentPath(path);
	}, []);

	const showingFile = !isDirPath(currentPath);

	const breadcrumbItems = breadcrumbs.map((crumb, index) => (
		<Text
			key={crumb.path}
			size="sm"
			c={index === breadcrumbs.length - 1 ? "bright" : "dimmed"}
			style={{ cursor: "pointer" }}
			onClick={() => goTo(crumb.path)}
		>
			{index === 0 ? (
				<Group gap={4} wrap="nowrap">
					<IconHome size={14} />
					<span>{crumb.label}</span>
				</Group>
			) : (
				crumb.label
			)}
		</Text>
	));

	return (
		<AppShell
			header={{ height: 56 }}
			navbar={{
				width: 320,
				breakpoint: "sm",
				collapsed: { mobile: false, desktop: isFileScope },
			}}
			padding="md"
		>
			<AppShell.Header>
				<Group h="100%" px="md" justify="space-between" wrap="nowrap">
					<Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
						<IconFolderOpen size={20} />
						<Title order={5} style={{ whiteSpace: "nowrap" }}>
							Workspace
						</Title>
						<Badge variant="light" size="sm" tt="none">
							{boot.scopeKind} · {boot.scopePath}
						</Badge>
					</Group>
					{showingFile && (
						<Button
							component="a"
							href={downloadUrl(currentPath)}
							leftSection={<IconDownload size={16} />}
							variant="light"
							size="xs"
						>
							Download
						</Button>
					)}
				</Group>
			</AppShell.Header>

			{!isFileScope && (
				<AppShell.Navbar p="sm">
					<Stack gap="xs" h="100%">
						<Breadcrumbs
							separator={<IconChevronRight size={12} />}
							separatorMargin={4}
						>
							{breadcrumbItems}
						</Breadcrumbs>

						<ScrollArea style={{ flex: 1 }} type="auto">
							{sortedEntries === null ? (
								<Group justify="center" p="md">
									<Loader size="sm" />
								</Group>
							) : sortedEntries.length === 0 ? (
								<Text c="dimmed" size="sm" ta="center" mt="md">
									Empty directory
								</Text>
							) : (
								<Stack gap={2}>
									{sortedEntries.map((entry) => {
										const name = basename(entry.path) || entry.path;
										const active = entry.path === currentPath;
										return (
											<NavLink
												key={entry.path}
												label={name}
												description={
													entry.is_dir ? undefined : formatSize(entry.size)
												}
												leftSection={
													entry.is_dir ? (
														<IconFolder size={16} />
													) : (
														<IconFile size={16} />
													)
												}
												active={active}
												onClick={() => goTo(entry.path)}
												styles={{ label: { fontSize: 13 } }}
											/>
										);
									})}
								</Stack>
							)}
						</ScrollArea>
					</Stack>
				</AppShell.Navbar>
			)}

			<AppShell.Main>
				<Stack gap="sm">
					{error && (
						<Alert
							icon={<IconAlertCircle size={16} />}
							color="red"
							variant="light"
						>
							{error}
						</Alert>
					)}

					{showingFile ? (
						<>
							<Group justify="space-between">
								<Text size="sm" c="dimmed" ff="monospace">
									{currentPath}
								</Text>
								{preview && (
									<Text size="xs" c="dimmed">
										{formatSize(preview.size)} · {preview.mime}
									</Text>
								)}
							</Group>
							<Paper p="lg" withBorder radius="md" className="fs-preview">
								{loadingPreview ? (
									<Group justify="center" p="xl">
										<Loader />
									</Group>
								) : preview ? (
									<FilePreview
										preview={preview}
										currentFile={currentPath}
										scopeRoot={scopeRoot}
										onNavigate={goTo}
									/>
								) : (
									<Text c="dimmed">No preview available.</Text>
								)}
							</Paper>
						</>
					) : (
						<Paper p="xl" withBorder radius="md">
							<Stack align="center" gap="xs">
								<IconFolderOpen size={32} opacity={0.5} />
								<Text c="dimmed" size="sm">
									{sortedEntries && sortedEntries.length > 0
										? "Select a file from the sidebar to preview it here."
										: `Directory ${currentPath} is empty.`}
								</Text>
							</Stack>
						</Paper>
					)}
				</Stack>
			</AppShell.Main>
		</AppShell>
	);
}
