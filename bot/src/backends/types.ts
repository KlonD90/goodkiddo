import type { BackendProtocol } from "deepagents";

export type WorkspaceBackend = BackendProtocol &
	Required<Pick<BackendProtocol, "downloadFiles">>;
