export type FileMetadata = {
	readonly filename?: string;
	readonly mimeType?: string;
	readonly byteSize?: number;
	readonly caption?: string;
};

export type CapabilityContent =
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "image"; mimeType: string; data: Uint8Array }
	  >;

export type CapabilityOutput = {
	readonly content: CapabilityContent;
	readonly currentUserText: string;
	readonly commandText?: string;
};

export type CapabilityResult =
	| { readonly ok: true; readonly value: CapabilityOutput }
	| { readonly ok: false; readonly userMessage: string };

export type CapabilityInput = {
	readonly bytes: Uint8Array;
	readonly metadata: FileMetadata;
};

export interface FileCapability {
	readonly name: string;
	canHandle(metadata: FileMetadata): boolean;
	prevalidate?(metadata: FileMetadata): CapabilityResult | null;
	process(input: CapabilityInput): Promise<CapabilityResult>;
}
