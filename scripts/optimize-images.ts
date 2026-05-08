import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import sharp from "sharp";

const roots = ["landing", "web"];
const imageExtensions = new Set([".jpg", ".jpeg", ".png"]);
const ignoredDirectories = new Set(["dist", "node_modules"]);
const minimumSavingsRatio = 0.03;
const checkOnly = process.argv.includes("--check");

async function collectImages(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const images: string[] = [];

	for (const entry of entries) {
		const path = join(directory, entry.name);

		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				images.push(...(await collectImages(path)));
			}
			continue;
		}

		if (entry.isFile() && imageExtensions.has(extname(entry.name).toLowerCase())) {
			images.push(path);
		}
	}

	return images;
}

async function optimizeImage(path: string) {
	const original = await readFile(path);
	const extension = extname(path).toLowerCase();
	const image = sharp(original, { animated: false }).rotate();
	const optimized =
		extension === ".png"
			? await image
					.png({
						adaptiveFiltering: true,
						compressionLevel: 9,
						effort: 10,
					})
					.toBuffer()
			: await image
					.jpeg({
						mozjpeg: true,
						progressive: true,
						quality: 82,
					})
					.toBuffer();

	const savedRatio = (original.byteLength - optimized.byteLength) / original.byteLength;

	if (optimized.byteLength >= original.byteLength || savedRatio < minimumSavingsRatio) {
		return { changed: false, original: original.byteLength, optimized: original.byteLength };
	}

	if (!checkOnly) {
		await writeFile(path, optimized);
	}

	return { changed: true, original: original.byteLength, optimized: optimized.byteLength };
}

let changed = 0;
let originalTotal = 0;
let optimizedTotal = 0;

for (const root of roots) {
	try {
		await stat(root);
	} catch {
		continue;
	}

	for (const imagePath of await collectImages(root)) {
		const result = await optimizeImage(imagePath);
		originalTotal += result.original;
		optimizedTotal += result.optimized;

		if (result.changed) {
			changed += 1;
			const saved = result.original - result.optimized;
			const percent = ((saved / result.original) * 100).toFixed(1);
			console.log(
				`${checkOnly ? "would optimize" : "optimized"} ${relative(process.cwd(), imagePath)} ` +
					`${result.original} -> ${result.optimized} bytes (${percent}% saved)`,
			);
		}
	}
}

const savedTotal = originalTotal - optimizedTotal;
const savedPercent = originalTotal === 0 ? "0.0" : ((savedTotal / originalTotal) * 100).toFixed(1);

console.log(
	`${checkOnly ? "checked" : "optimized"} ${changed} image(s); ` +
		`${originalTotal} -> ${optimizedTotal} bytes (${savedPercent}% saved)`,
);

if (checkOnly && changed > 0) {
	process.exitCode = 1;
}
