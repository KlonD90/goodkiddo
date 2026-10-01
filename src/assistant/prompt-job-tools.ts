import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LlmTool } from '../providers/assistant-llm.js';
import type { ToolContext } from './tools.js';
import type { PromptJobInput } from '../persistence/assistant-prompt-jobs.js';

const input = z.object({
  title: z.string().min(1).max(200),
  prompt: z.string().min(1).max(10000),
  cron: z
    .string()
    .max(100)
    .describe(
      '5 cron fields with one fixed minute; at most hourly. Example: 0 8 * * *',
    ),
  timezone: z.string().max(80).describe('Confirmed IANA timezone'),
  notification: z
    .enum(['verbose', 'summary', 'errors_only', 'silent'])
    .default('summary'),
  maxCalls: z.number().int().min(1).max(6).optional(),
  maxSearches: z.number().int().min(0).max(3).optional(),
  maxCostUsd: z.number().min(0).max(1).optional(),
});
const schemas = {
  create_prompt_job: input,
  list_prompt_jobs: z.object({}),
  update_prompt_job: input
    .partial()
    .extend({
      id: z.string(),
      status: z.enum(['active', 'paused', 'cancelled']).optional(),
    }),
  prompt_job_runs: z.object({ id: z.string() }),
  prompt_job_result: z.object({ run_id: z.string() }),
};
const descriptions: Record<keyof typeof schemas, string> = {
  create_prompt_job:
    'Persist a recurring read/research/report prompt in this chat after the user requests repetition and confirms schedule/timezone. At most hourly; future runs are bounded, cannot create tasks or mutate files/memory, and share daily/monthly caps. After 3 failed executions the job pauses. Notification: verbose full, summary short, errors_only failures, silent none. Full results remain readable.',
  list_prompt_jobs:
    'List recurring jobs including paused jobs, next run, notification mode and budgets in this chat.',
  update_prompt_job:
    'Edit, pause, resume or cancel your own recurring job in this chat. Editing cancels its in-flight result/pending notification and reschedules from now.',
  prompt_job_runs:
    'List the latest 20 stored execution results/statuses for a recurring job in this chat.',
  prompt_job_result:
    'Read a stored recurring execution result in this chat, including results without notifications.',
};
export function promptJobToolDefinitions(): LlmTool[] {
  return Object.entries(schemas).map(([name, schema]) => ({
    type: 'function',
    function: {
      name,
      description: descriptions[name as keyof typeof schemas],
      parameters: z.toJSONSchema(schema),
    },
  }));
}
export function isPromptJobTool(name: string): boolean {
  return Object.hasOwn(schemas, name);
}
export function executePromptJobTool(
  name: string,
  raw: string,
  ctx: ToolContext,
): unknown {
  const { store, request, config } = ctx;
  const data = JSON.parse(raw);
  switch (name) {
    case 'list_prompt_jobs':
      schemas.list_prompt_jobs.parse(data);
      return store.promptJobs.list(request.chat.id);
    case 'prompt_job_runs': {
      const a = schemas.prompt_job_runs.parse(data);
      return store.promptJobs.runs(request.chat.id, a.id);
    }
    case 'prompt_job_result': {
      const a = schemas.prompt_job_result.parse(data);
      return store.promptJobs.result(request.chat.id, a.run_id);
    }
    case 'create_prompt_job': {
      const a = schemas.create_prompt_job.parse(data);
      const limits = boundedLimits(
        {
          maxCalls: a.maxCalls ?? Math.min(config.maxCalls, 6),
          maxSearches: a.maxSearches ?? Math.min(config.maxSearches, 3),
          maxCostUsd: a.maxCostUsd ?? Math.min(config.monthlyBudget, 0.1),
        },
        ctx,
      );
      const job = { ...a, ...limits } satisfies PromptJobInput;
      const origin = `${ctx.taskId}:prompt:${createHash('sha256').update(JSON.stringify(job)).digest('hex')}`;
      return store.promptJobs.create(
        request.chat.id,
        request.actor.id,
        job,
        origin,
        config.maxActiveJobs,
      );
    }
    case 'update_prompt_job': {
      const { id, ...change } = schemas.update_prompt_job.parse(data);
      const existing = store.promptJobs.get(id);
      if (!existing || existing.chatId !== request.chat.id)
        throw new Error('Задача не найдена в этом чате.');
      const limits = boundedLimits(
        {
          maxCalls: change.maxCalls ?? existing.maxCalls,
          maxSearches: change.maxSearches ?? existing.maxSearches,
          maxCostUsd: change.maxCostUsd ?? existing.maxCostUsd,
        },
        ctx,
      );
      return store.promptJobs.update(request.chat.id, request.actor.id, id, {
        ...change,
        ...limits,
      });
    }
    default:
      throw new Error('Неизвестный инструмент.');
  }
}
function boundedLimits(
  limits: Pick<PromptJobInput, 'maxCalls' | 'maxSearches' | 'maxCostUsd'>,
  ctx: ToolContext,
) {
  if (
    limits.maxCalls > ctx.config.maxCalls ||
    limits.maxSearches > ctx.config.maxSearches ||
    limits.maxCostUsd > ctx.config.monthlyBudget
  )
    throw new Error('Лимиты задания превышают общие лимиты конфигурации.');
  return limits;
}
