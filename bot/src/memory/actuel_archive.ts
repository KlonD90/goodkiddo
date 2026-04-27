import { ACTUEL_HEADING, ARCHIVE_HEADING } from "./layout";

// Karpathy's "actuel/archive" compaction pattern: the current-state body lives
// under ## Actuel, and when it's superseded the previous body is prepended to
// ## Archive under a dated sub-heading. Nothing is ever deleted — just pushed
// down. Keeps history compact and auditable without bloating the hot path.

type Sections = {
	header: string;
	actuel: string;
	archive: string;
};

function splitSections(content: string): Sections {
	const actuelIndex = content.indexOf(`\n${ACTUEL_HEADING}`);
	const archiveIndex = content.indexOf(`\n${ARCHIVE_HEADING}`);

	if (actuelIndex === -1) {
		return { header: content, actuel: "", archive: "" };
	}

	const header = content.slice(0, actuelIndex);

	if (archiveIndex === -1 || archiveIndex < actuelIndex) {
		const actuelBody = content
			.slice(actuelIndex + 1 + ACTUEL_HEADING.length)
			.replace(/^\n+/, "");
		return { header, actuel: actuelBody, archive: "" };
	}

	const actuelBody = content
		.slice(actuelIndex + 1 + ACTUEL_HEADING.length, archiveIndex)
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");
	const archiveBody = content
		.slice(archiveIndex + 1 + ARCHIVE_HEADING.length)
		.replace(/^\n+/, "");

	return { header, actuel: actuelBody, archive: archiveBody };
}

function composeSections(sections: Sections): string {
	const parts: string[] = [];
	if (sections.header.length > 0)
		parts.push(sections.header.replace(/\n+$/, ""));
	parts.push(ACTUEL_HEADING);
	parts.push(sections.actuel);
	if (sections.archive.trim().length > 0) {
		parts.push("");
		parts.push(ARCHIVE_HEADING);
		parts.push(sections.archive.replace(/\n+$/, ""));
	}
	return `${parts.join("\n\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

// Build a brand-new file (used when kind=note and the topic doesn't exist yet).
export function composeFresh(header: string, actuelBody: string): string {
	return composeSections({
		header: header.trim(),
		actuel: actuelBody.trim(),
		archive: "",
	});
}

// Replace Actuel outright (mode: "replace"). If the file has no Actuel section
// yet, fall back to a fresh compose preserving the header.
export function applyReplace(
	existingContent: string,
	newActuelBody: string,
): string {
	const sections = splitSections(existingContent);
	return composeSections({
		header: sections.header.trim(),
		actuel: newActuelBody.trim(),
		archive: sections.archive,
	});
}

// Rotate: move current Actuel body into Archive under ### [DATE], replace with
// the new body (mode: "rotate_actuel").
export function applyRotate(
	existingContent: string,
	newActuelBody: string,
	date: string,
): string {
	const sections = splitSections(existingContent);
	const previousActuel = sections.actuel.trim();
	const archiveEntry =
		previousActuel.length > 0 ? `### [${date}]\n${previousActuel}` : "";
	const archiveBody =
		archiveEntry.length === 0
			? sections.archive
			: sections.archive.trim().length === 0
				? archiveEntry
				: `${archiveEntry}\n\n${sections.archive}`;

	return composeSections({
		header: sections.header.trim(),
		actuel: newActuelBody.trim(),
		archive: archiveBody,
	});
}

export function currentActuel(content: string): string {
	return splitSections(content).actuel.trim();
}
