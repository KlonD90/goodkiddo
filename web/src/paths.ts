export interface BreadcrumbItem {
	label: string;
	path: string;
}

export function isDirPath(path: string): boolean {
	return path === "/" || path.endsWith("/");
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

function decodeLinkPath(path: string): string {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
}

function stripLinkDecoration(href: string): string {
	const marker = href.search(/[?#]/);
	return marker === -1 ? href : href.slice(0, marker);
}

function hasExternalScheme(href: string): boolean {
	return href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href);
}

export function resolveRelativePath(
	currentFile: string,
	href: string,
): string | null {
	if (!href || href.startsWith("#") || hasExternalScheme(href)) return null;

	const pathOnly = decodeLinkPath(stripLinkDecoration(href));
	if (!pathOnly) return null;

	const baseDir = parentDir(currentFile);
	const target = pathOnly.startsWith("/")
		? pathOnly
		: `${baseDir}${pathOnly.replace(/^\.\//, "")}`;
	const preserveTrailingSlash = target.endsWith("/");
	const segments: string[] = [];

	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			segments.pop();
			continue;
		}
		segments.push(part);
	}

	if (segments.length === 0) return "/";
	return `/${segments.join("/")}${preserveTrailingSlash ? "/" : ""}`;
}

export function isWithinScope(path: string, scopeRoot: string): boolean {
	if (scopeRoot === "/") return true;
	const normalizedRoot = scopeRoot.endsWith("/") ? scopeRoot : `${scopeRoot}/`;
	return (
		path === normalizedRoot ||
		path === normalizedRoot.replace(/\/$/, "") ||
		path.startsWith(normalizedRoot)
	);
}

export function buildBreadcrumbs(
	currentPath: string,
	scopeRoot: string,
): BreadcrumbItem[] {
	const normalizedRoot =
		scopeRoot === "/" || scopeRoot.endsWith("/") ? scopeRoot : `${scopeRoot}/`;
	const rootLabel = normalizedRoot === "/" ? "root" : basename(normalizedRoot);
	const crumbs: BreadcrumbItem[] = [
		{ label: rootLabel || "scope", path: normalizedRoot },
	];
	const rootWithoutSlash = normalizedRoot.replace(/\/$/, "") || "/";

	if (currentPath === normalizedRoot || currentPath === rootWithoutSlash) {
		return crumbs;
	}

	const relative =
		normalizedRoot === "/"
			? currentPath.replace(/^\/+/, "")
			: currentPath.startsWith(normalizedRoot)
				? currentPath.slice(normalizedRoot.length)
				: currentPath.replace(/^\/+/, "");
	const parts = relative.replace(/\/+$/, "").split("/").filter(Boolean);
	let acc = normalizedRoot;

	parts.forEach((part, index) => {
		const isLast = index === parts.length - 1;
		const path = `${acc}${part}${isLast && !isDirPath(currentPath) ? "" : "/"}`;
		crumbs.push({ label: part, path });
		acc = path.endsWith("/") ? path : `${path}/`;
	});

	return crumbs;
}
