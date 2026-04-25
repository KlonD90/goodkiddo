export async function fetchVoiceBytes(
	file: { file_path?: string },
	botToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ data: Uint8Array; filePath: string }> {
	const filePath = file.file_path;
	if (typeof filePath !== "string" || filePath === "") {
		throw new Error("Telegram did not return a downloadable file path.");
	}

	const response = await fetchImpl(
		`https://api.telegram.org/file/bot${botToken}/${filePath}`,
	);
	if (!response.ok) {
		throw new Error(
			`Telegram file download failed with status ${response.status}.`,
		);
	}

	return {
		data: new Uint8Array(await response.arrayBuffer()),
		filePath,
	};
}
