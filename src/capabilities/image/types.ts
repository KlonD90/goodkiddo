export interface ImageUnderstandInput {
	prompt: string;
	bytes: Uint8Array;
	extension: string;
	signal?: AbortSignal;
}

export interface ImageUnderstandOutput {
	text: string;
}

export interface ImageUnderstandingProvider {
	understand(input: ImageUnderstandInput): Promise<ImageUnderstandOutput>;
	close(): Promise<void>;
}
