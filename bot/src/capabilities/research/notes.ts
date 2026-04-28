const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function mintId(): string {
	let id = "r-";
	for (let i = 0; i < 8; i++) {
		id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
	}
	return id;
}

export type ResearchFinding = {
	source: string;
	summary: string;
};

export class ResearchNotes {
	private findings: ResearchFinding[] = [];

	add(source: string, summary: string): void {
		this.findings.push({ source, summary });
	}

	serializeMarkdown(): string {
		if (this.findings.length === 0) {
			return "# Research Notes\n\n_No findings recorded._\n";
		}
		const sections = this.findings.map(
			(f, i) =>
				`## Finding ${i + 1}: ${f.source}\n\n${f.summary}`,
		);
		return `# Research Notes\n\n${sections.join("\n\n")}\n`;
	}
}
