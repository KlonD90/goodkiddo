const MIME_MAP: Record<string, string> = {
	// Images
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
	bmp: "image/bmp",
	tiff: "image/tiff",
	tif: "image/tiff",
	// Audio
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	flac: "audio/flac",
	// Video
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	avi: "video/x-msvideo",
	mkv: "video/x-matroska",
	// Documents / binary
	pdf: "application/pdf",
	zip: "application/zip",
	tar: "application/x-tar",
	gz: "application/gzip",
	wasm: "application/wasm",
	// Text
	txt: "text/plain",
	md: "text/markdown",
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	csv: "text/csv",
	svg: "image/svg+xml",
	xml: "text/xml",
	// Code (text)
	ts: "text/plain",
	tsx: "text/plain",
	js: "text/plain",
	jsx: "text/plain",
	json: "application/json",
	py: "text/plain",
	rb: "text/plain",
	go: "text/plain",
	rs: "text/plain",
	sh: "text/plain",
	yaml: "text/plain",
	yml: "text/plain",
	toml: "text/plain",
	env: "text/plain",
};

export function getMimeType(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return MIME_MAP[ext] ?? "text/plain";
}

export function isTextMimeType(mime: string): boolean {
	return (
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/xml" ||
		mime === "image/svg+xml"
	);
}
