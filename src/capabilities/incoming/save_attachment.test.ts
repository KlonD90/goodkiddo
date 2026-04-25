import { describe, expect, test } from "bun:test";
import { SqliteStateBackend } from "../../backends";
import { createDb, detectDialect } from "../../db";
import { INCOMING_DIR, saveIncomingAttachment } from "./save_attachment";

function createBackend(namespace: string) {
	const db = createDb("sqlite://:memory:");
	const dialect = detectDialect("sqlite://:memory:");
	return new SqliteStateBackend({ db, dialect, namespace });
}

describe("saveIncomingAttachment", () => {
	test("writes bytes under /incoming/ and returns the vfs path", async () => {
		const backend = createBackend("save-1");
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20]);

		const { vfsPath } = await saveIncomingAttachment({
			backend,
			bytes,
			extension: "jpg",
		});

		expect(vfsPath).toMatch(/^\/incoming\/\d+-[a-z0-9]{6}\.jpg$/);

		const [downloaded] = await backend.downloadFiles([vfsPath]);
		expect(downloaded.error).toBeNull();
		expect(downloaded.content).not.toBeNull();
		expect(Array.from(downloaded.content as Uint8Array)).toEqual(
			Array.from(bytes),
		);
	});

	test("normalizes leading dot and uppercase extensions", async () => {
		const backend = createBackend("save-2");
		const { vfsPath } = await saveIncomingAttachment({
			backend,
			bytes: new Uint8Array([1, 2, 3]),
			extension: ".PNG",
		});
		expect(vfsPath.endsWith(".png")).toBe(true);
	});

	test("rejects extensions with unsafe characters", async () => {
		const backend = createBackend("save-3");
		await expect(
			saveIncomingAttachment({
				backend,
				bytes: new Uint8Array([1]),
				extension: "../etc",
			}),
		).rejects.toThrow(/Invalid attachment extension/u);
	});

	test("does not collide when called twice in rapid succession", async () => {
		const backend = createBackend("save-4");
		const a = await saveIncomingAttachment({
			backend,
			bytes: new Uint8Array([1]),
			extension: "jpg",
		});
		const b = await saveIncomingAttachment({
			backend,
			bytes: new Uint8Array([2]),
			extension: "jpg",
		});

		expect(a.vfsPath).not.toBe(b.vfsPath);
		expect(a.vfsPath.startsWith(`${INCOMING_DIR}/`)).toBe(true);
		expect(b.vfsPath.startsWith(`${INCOMING_DIR}/`)).toBe(true);
	});
});
