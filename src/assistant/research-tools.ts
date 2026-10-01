import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LlmTool } from '../providers/assistant-llm.js';
import type { ToolContext } from './tools.js';
import {
  runResearch,
  researchSchema,
  ResearchCallLimit,
  type ResearchTool,
} from '../capabilities/research/agent.js';
import { ResearchNotes } from '../capabilities/research/notes.js';
import { browserResearchTools } from '../capabilities/browser/tools.js';
import type { ReadOnlyBrowserJob } from '../capabilities/browser/job.js';
import { AssistantFiles } from '../persistence/assistant-files.js';
import { textBytes } from '../persistence/assistant-file-policy.js';
import { fileToolDefinitions, executeFileTool } from './file-tools.js';
import { webToolDefinitions, executeWebTool } from './web-tools.js';
import {
  attachmentToolDefinitions,
  executeAttachmentTool,
} from './attachment-tools.js';
import {
  BudgetExceeded,
  enforceDailyLimits,
  meteredCompletion,
} from './budget.js';

const used = new WeakSet<object>();
const FILE_READS = new Set(['ls', 'read_file', 'glob', 'grep']);

export function researchToolDefinitions(): LlmTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'research',
        description:
          "Delegate a multi-source investigation to one bounded read-only subagent using this task's configured model and budget. Supplied public links work without search. Browser rendering is available only if an approved worker is connected. Compact synthesis and same-chat notes; no actions or communications.",
        parameters: z.toJSONSchema(researchSchema),
      },
    },
  ];
}

// An integrator may inject an already approved browser job or search adapter. Neither
// is configured, installed, contacted or enabled by this module's defaults.
export async function executeResearchTool(
  input: unknown,
  ctx: ToolContext,
  dependencies: { browser?: ReadOnlyBrowserJob; search?: ResearchTool } = {},
) {
  if (
    dependencies.browser &&
    (dependencies.browser.owner.chatId !== ctx.request.chat.id ||
      dependencies.browser.owner.taskId !== ctx.taskId)
  )
    throw new Error('Browser job belongs to another chat or task.');
  try {
    return await executeResearch(input, ctx, dependencies);
  } finally {
    await dependencies.browser?.close();
  }
}

async function executeResearch(
  input: unknown,
  ctx: ToolContext,
  dependencies: { browser?: ReadOnlyBrowserJob; search?: ResearchTool },
) {
  const brief = researchSchema.parse(input);
  if (used.has(ctx))
    throw new Error('Only one research subagent is allowed per task.');
  if (!ctx.llm || !ctx.analytics)
    throw new Error('Research model is unavailable.');
  used.add(ctx);
  enforceDailyLimits(ctx.store, ctx.config, ctx.request, true, ctx.taskId);
  ctx.store.setTaskType(ctx.taskId, 'research');
  // Existing dailyResearch accounting uses used_search for heavy web tasks.
  ctx.store.db
    .query('UPDATE assistant_runs SET used_search=1 WHERE id=?')
    .run(ctx.taskId);
  const files = new AssistantFiles(ctx.store.db, ctx.config.fileLimits);
  const notes = new ResearchNotes();
  const noteId = createHash('sha256')
    .update(ctx.taskId)
    .digest('hex')
    .slice(0, 20);
  const notesPath = `/research/${noteId}.json`;
  let documentReads = 0;
  const researchSignal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(60_000),
  ]);
  const pageContext = { signal: researchSignal };
  const tools: ResearchTool[] = [
    {
      definition: webToolDefinitions()[0],
      execute: (args) => executeWebTool(args, pageContext),
    },
    ...fileToolDefinitions()
      .filter((tool) => FILE_READS.has(tool.function.name))
      .map((definition) => ({
        definition,
        execute: (args: unknown) =>
          executeFileTool(definition.function.name, args, ctx),
      })),
    {
      definition: attachmentToolDefinitions()[0],
      execute: (args, signal) => {
        if (++documentReads > 2)
          throw new Error('Document read limit reached.');
        return executeAttachmentTool(
          args,
          { request: ctx.request, signal },
          files,
        );
      },
    },
    ...(dependencies.browser ? browserResearchTools(dependencies.browser) : []),
    ...(dependencies.search ? [dependencies.search] : []),
  ];
  try {
    const result = await runResearch({
      brief,
      notes,
      tools,
      signal: researchSignal,
      fatalError: (error) => error instanceof BudgetExceeded,
      complete: async (messages, definitions, signal) => {
        const run = ctx.store.db
          .query('SELECT llm_calls FROM assistant_runs WHERE id=?')
          .get(ctx.taskId) as { llm_calls: number } | null;
        // Reserve one outer call for a final user-facing synthesis.
        if ((run?.llm_calls || 0) >= ctx.config.maxCalls - 1)
          throw new ResearchCallLimit(
            'Research reached the shared model-call limit.',
          );
        return meteredCompletion({
          ...ctx,
          llm: ctx.llm!,
          analytics: ctx.analytics!,
          signal,
          messages,
          tools: definitions,
          onContent: undefined,
          images: undefined,
        });
      },
    });
    return { ...result, notes_path: notesPath, findings: notes.snapshot() };
  } finally {
    // The model cannot choose a path or mutate files; orchestration stores bounded
    // immutable notes in the same chat using existing VFS quotas.
    files.write(
      ctx.request.chat.id,
      notesPath,
      textBytes(notes.serialize()),
      'application/json',
      `${ctx.taskId}:research-notes`,
    );
  }
}
