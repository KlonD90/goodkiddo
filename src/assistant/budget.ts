import { randomUUID } from 'node:crypto';
import type { AssistantConfig } from '../config/assistant-config.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import type { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import type { AssistantLlm, LlmTool } from '../providers/assistant-llm.js';
import type { InboundRequest, LlmMessage } from '../shared/assistant-types.js';
import type { ContentSnapshot } from '../providers/assistant-stream.js';
import type { ImageInput } from '../providers/assistant-vision.js';

export class BudgetExceeded extends Error {
  constructor(
    message = 'Лимит расходов на этот месяц исчерпан. Сохранённые напоминания и встречи продолжат работать.',
  ) {
    super(message);
  }
}
export function reserveBudget(
  store: AssistantStore,
  config: AssistantConfig,
  amount: number,
  scope?: { taskId: string; maxCostUsd: number },
): string {
  return store.transaction(() => {
    if (scope) {
      const used = Number(store.state(`task_spend:${scope.taskId}`) || 0);
      if (used + amount > scope.maxCostUsd + 1e-9)
        throw new BudgetExceeded(
          'Лимит расходов этого периодического запуска исчерпан.',
        );
    }
    if (store.monthSpend() + amount > config.monthlyBudget)
      throw new BudgetExceeded();
    const id = randomUUID();
    store.reserveSpend(id, amount);
    if (scope)
      store.setState(
        `task_spend:${scope.taskId}`,
        String(Number(store.state(`task_spend:${scope.taskId}`) || 0) + amount),
      );
    return id;
  });
}
export function enforceDailyLimits(
  store: AssistantStore,
  config: AssistantConfig,
  request: InboundRequest,
  heavy = false,
  exclude = '',
): void {
  const maxUser = heavy ? config.dailyResearch : config.dailyTasks;
  const maxChat = heavy ? config.dailyChatResearch : config.dailyChatTasks;
  if (
    store.dailyCount('user_id', request.actor.id, heavy, exclude) >= maxUser ||
    store.dailyCount('chat_id', request.chat.id, heavy, exclude) >= maxChat
  ) {
    throw new BudgetExceeded(
      heavy
        ? 'Лимит задач с веб-поиском на сегодня исчерпан. Он обновится в 00:00 UTC.'
        : 'Лимит задач на сегодня исчерпан. Он обновится в 00:00 UTC; напоминания и встречи продолжат работать.',
    );
  }
}
export async function meteredCompletion(args: {
  store: AssistantStore;
  config: AssistantConfig;
  analytics: AssistantAnalytics;
  llm: AssistantLlm;
  request: InboundRequest;
  taskId: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  signal: AbortSignal;
  onContent?: ContentSnapshot;
  images?: ImageInput[];
}): Promise<LlmMessage> {
  const {
    store,
    config,
    analytics,
    llm,
    taskId,
    request,
    messages,
    tools,
    signal,
  } = args;
  const run = store.db
    .query('SELECT llm_calls FROM assistant_runs WHERE id=?')
    .get(taskId) as { llm_calls: number } | null;
  if (run && run.llm_calls >= config.maxCalls)
    throw new BudgetExceeded(
      'Достигнут лимит обращений к модели в этой задаче. Сохранённые задания остаются в /tasks.',
    );
  // Conservative reservation: one token per UTF-8 byte plus framing; actual usage settles it.
  const estimatedInput =
    Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8') +
    1024 +
    (args.images || []).reduce(
      (total, image) => total + Math.ceil((image.bytes.length * 4) / 3) + 256,
      0,
    );
  const reserved =
    (estimatedInput * config.inputPrice +
      config.maxOutputTokens * config.outputPrice) /
    1e6;
  const scope = request.scheduled
    ? { taskId, maxCostUsd: request.scheduled.maxCostUsd }
    : undefined;
  const callId = reserveBudget(store, config, reserved, scope);
  let input = estimatedInput;
  let output = config.maxOutputTokens;
  let cost = reserved;
  let estimated = true;
  try {
    const response = await llm.complete(
      messages,
      tools,
      signal,
      args.onContent,
      args.images,
    );
    const usage = response.usage;
    if (
      usage &&
      Number.isFinite(usage.prompt_tokens) &&
      Number.isFinite(usage.completion_tokens)
    ) {
      input = Math.max(0, usage.prompt_tokens!);
      output = Math.max(0, usage.completion_tokens!);
      cost =
        typeof usage.cost === 'number' &&
        Number.isFinite(usage.cost) &&
        usage.cost >= 0
          ? usage.cost
          : (input * config.inputPrice + output * config.outputPrice) / 1e6;
      estimated = false;
    }
    return response.message;
  } finally {
    // Keep the reservation for ambiguous failures: a timed-out request may still be billed.
    store.settleSpend(callId, cost);
    if (scope)
      store.setState(
        `task_spend:${taskId}`,
        String(
          Math.max(
            0,
            Number(store.state(`task_spend:${taskId}`) || 0) - reserved + cost,
          ),
        ),
      );
    store.addUsage(taskId, {
      llm_calls: 1,
      tokens_in: input,
      tokens_out: output,
      cost_usd: cost,
    });
    analytics.track(callId, 'llm_usage', request.chat, request.actor.id, {
      task_id: taskId,
      model: config.model,
      provider: config.provider,
      tokens_in: input,
      tokens_out: output,
      cost_usd: cost,
      usage_estimated: estimated,
    });
  }
}
