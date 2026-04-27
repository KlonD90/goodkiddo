import { z } from "zod";

export const RuntimeSchema = z.enum([
	"python",
	"bun",
	"shell",
	"agent-browser",
]);
export const TaskTypeSchema = z.enum(["standard", "browser", "heavy"]);
export const OutputTypeSchema = z.enum(["file", "directory"]);
export const SessionModeSchema = z.enum(["isolated-data", "networked-exec"]);
export const ArtifactStatusSchema = z.enum(["active", "quarantined"]);

export const DataRequirementSchema = z.object({
	category: z.string().min(1),
	fields: z.array(z.string().min(1)).min(1),
	reason: z.string().min(1),
});

export const ExpectedOutputSchema = z.object({
	path: z.string().min(1),
	type: OutputTypeSchema.default("file"),
	description: z.string().min(1),
});

export const SupportFileSchema = z.object({
	path: z.string().min(1),
	content: z.string(),
});

export const ExecuteScriptInputSchema = z.object({
	runtime: RuntimeSchema,
	script: z.string().min(1).describe("The path of the script to execute"),
	filename: z.string().min(1),
	args: z
		.array(z.string())
		.default([])
		.describe("The arguments to pass to the script"),
	supportFiles: z.array(SupportFileSchema).default([]),
	expectedOutputs: z.array(ExpectedOutputSchema).default([]),
	dataRequirements: z.array(DataRequirementSchema).default([]),
	networkDomains: z.array(z.string().min(1)).default([]),
	taskType: TaskTypeSchema.optional(),
});

export const ExecuteWorkspaceInputSchema = z.object({
	runtime: RuntimeSchema,
	entrypoint: z.string().min(1),
	args: z.array(z.string()).default([]),
	expectedOutputs: z.array(ExpectedOutputSchema).default([]),
	dataRequirements: z.array(DataRequirementSchema).default([]),
	networkDomains: z.array(z.string().min(1)).default([]),
	taskType: TaskTypeSchema.optional(),
});

export const OutputArtifactSchema = z.object({
	path: z.string(),
	type: OutputTypeSchema,
	status: ArtifactStatusSchema,
	content: z.string().optional(),
});

export const ExecuteResultSchema = z.object({
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
	outputArtifacts: z.array(OutputArtifactSchema),
	durationMs: z.number(),
});

export const ManifestFileSchema = z.object({
	path: z.string(),
	hash: z.string(),
});

export const InternalExecutionManifestSchema = z.object({
	entrypoint: z.string(),
	runtime: RuntimeSchema,
	args: z.array(z.string()),
	files: z.array(ManifestFileSchema),
	expectedOutputs: z.array(ExpectedOutputSchema),
	dataRequirements: z.array(DataRequirementSchema),
	requiresNetwork: z.boolean(),
	networkDomains: z.array(z.string()),
	requestedTaskType: TaskTypeSchema,
	grantedTaskType: TaskTypeSchema,
	sessionMode: SessionModeSchema,
});

export type Runtime = z.infer<typeof RuntimeSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type SessionMode = z.infer<typeof SessionModeSchema>;
export type DataRequirement = z.infer<typeof DataRequirementSchema>;
export type ExpectedOutput = z.infer<typeof ExpectedOutputSchema>;
export type SupportFile = z.infer<typeof SupportFileSchema>;
export type ExecuteScriptInput = z.infer<typeof ExecuteScriptInputSchema>;
export type ExecuteWorkspaceInput = z.infer<typeof ExecuteWorkspaceInputSchema>;
export type InternalExecutionManifest = z.infer<
	typeof InternalExecutionManifestSchema
>;
export type OutputArtifact = z.infer<typeof OutputArtifactSchema>;
export type ExecuteResult = z.infer<typeof ExecuteResultSchema>;
