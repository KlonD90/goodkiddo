import MarkdownIt from "markdown-it";
import { useCallback, useEffect, useMemo, useState } from "react";
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
		acc += `${part}${index === parts.length - 1 && !isDirPath(currentPath) ? "" : "/"}`;
		crumbs.push({ label: part, path: acc });
	});
	return crumbs;
}

function updateUrl(path: string): void {
	const urlPath = `/${boot.linkUuid}${path}`;
	history.replaceState(null, "", urlPath);
}

function FilePreview({ preview }: { preview: PreviewResponse }) {
	if (preview.too_large) {
		return (
			<div className="error">
				File is too large to preview ({formatSize(preview.size)}). Download it
				to view.
			</div>
		);
	}
	const b64 = preview.content_base64 ?? "";

	if (preview.mime === "text/markdown") {
		const text = atob(b64);
		const html = md.render(text);
		return (
			<div
				className="markdown"
				// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via markdown-it with html:false
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		);
	}

	if (preview.mime.startsWith("image/")) {
		return (
			<img src={`data:${preview.mime};base64,${b64}`} alt={preview.path} />
		);
	}

	if (preview.mime === "application/pdf") {
		return (
			<iframe
				title={preview.path}
				src={`data:${preview.mime};base64,${b64}`}
				style={{ width: "100%", height: "80vh", border: "none" }}
			/>
		);
	}

	if (
		preview.mime.startsWith("text/") ||
		preview.mime === "application/json" ||
		preview.mime === "application/xml"
	) {
		const text = atob(b64);
		return <pre>{text}</pre>;
	}

	return (
		<div>
			Binary file ({formatSize(preview.size)}). Use the Download button to
			retrieve it.
		</div>
	);
}

export function App() {
	const scopeRoot =
		boot.scopeKind === "file" ? parentDir(boot.scopePath) : boot.scopePath;
	const [currentPath, setCurrentPath] = useState<string>(boot.initialPath);
	const [entries, setEntries] = useState<FsEntry[] | null>(null);
	const [preview, setPreview] = useState<PreviewResponse | null>(null);
	const [error, setError] = useState<string | null>(null);

	const isFileScope = boot.scopeKind === "file";

	const loadDirectory = useCallback(async (dirPath: string) => {
		try {
			setError(null);
			const result = await listDirectory(dirPath);
			setEntries(result.entries);
			setPreview(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEntries([]);
		}
	}, []);

	const loadPreview = useCallback(async (filePath: string) => {
		try {
			setError(null);
			const result = await previewFile(filePath);
			setPreview(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPreview(null);
		}
	}, []);

	useEffect(() => {
		updateUrl(currentPath);
		if (isDirPath(currentPath)) {
			if (!isFileScope) void loadDirectory(currentPath);
		} else {
			void loadPreview(currentPath);
			if (!isFileScope) {
				const parent = parentDir(currentPath);
				if (entries === null) void loadDirectory(parent);
			}
		}
	}, [currentPath, isFileScope, loadDirectory, loadPreview, entries]);

	const breadcrumbs = useMemo(
		() => (isFileScope ? [] : buildBreadcrumbs(currentPath, scopeRoot)),
		[currentPath, scopeRoot, isFileScope],
	);

	const listedDir = useMemo(() => {
		if (isFileScope) return "";
		return isDirPath(currentPath) ? currentPath : parentDir(currentPath);
	}, [currentPath, isFileScope]);

	const openEntry = (entry: FsEntry) => {
		setCurrentPath(entry.path);
	};

	const goTo = (path: string) => {
		setCurrentPath(path);
	};

	return (
		<>
			{!isFileScope && (
				<nav>
					<div className="breadcrumbs">
						{breadcrumbs.map((crumb, index) => (
							<span key={crumb.path}>
								{index > 0 && <span>/</span>}
								<button
									type="button"
									className="breadcrumb"
									onClick={() => goTo(crumb.path)}
								>
									{crumb.label}
								</button>
							</span>
						))}
					</div>
					{entries === null ? (
						<div>Loading…</div>
					) : entries.length === 0 ? (
						<div style={{ color: "#8a919c", fontSize: 13 }}>Empty</div>
					) : (
						<ul className="file-list">
							{entries.map((entry) => (
								<li
									key={entry.path}
									className={entry.path === currentPath ? "active" : ""}
									onClick={() => openEntry(entry)}
									onKeyDown={(event) => {
										if (event.key === "Enter") openEntry(entry);
									}}
								>
									<span>
										{entry.is_dir ? "📁 " : "📄 "}
										{basename(entry.path) || entry.path}
									</span>
									{!entry.is_dir && (
										<span className="size">{formatSize(entry.size)}</span>
									)}
								</li>
							))}
						</ul>
					)}
				</nav>
			)}
			<main>
				{error && <div className="error">Error: {error}</div>}
				{!isDirPath(currentPath) && (
					<div className="toolbar">
						<span style={{ flex: 1, alignSelf: "center", fontSize: 14 }}>
							{currentPath}
						</span>
						<a className="button" href={downloadUrl(currentPath)} download>
							Download
						</a>
					</div>
				)}
				{isDirPath(currentPath) ? (
					<div style={{ color: "#8a919c" }}>
						{entries && entries.length > 0
							? "Select a file from the sidebar."
							: listedDir
								? `Directory ${listedDir} is empty.`
								: ""}
					</div>
				) : preview ? (
					<div className="preview">
						<FilePreview preview={preview} />
					</div>
				) : (
					<div>Loading…</div>
				)}
			</main>
		</>
	);
}
