declare module "*.md?raw" {
	const content: string;
	export default content;
}

declare module "*.md" {
	const content: string;
	export default content;
}

declare namespace NodeJS {
	interface ProcessEnv {
		DATABASE_URL?: string;
		TRANSCRIPTION_API_KEY?: string;
		TRANSCRIPTION_BASE_URL?: string;
		POSTHOG_KEY?: string;
		POSTHOG_HOST?: string;
	}
}
