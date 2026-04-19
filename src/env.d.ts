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
		/** @deprecated Use DATABASE_URL with a sqlite:// prefix instead */
		STATE_DB_PATH?: string;
	}
}
