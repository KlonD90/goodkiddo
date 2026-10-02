import { randomUUID } from 'node:crypto';
import type { AssistantConfig } from '../config/assistant-config.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import type { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import type { AssistantLlm, LlmTool } from '../providers/assistant-llm.js';
import type { InboundRequest, LlmMessage } from '../shared/assistant-types.js';
import type { ContentSnapshot } from '../providers/assistant-stream.js';
import type { ImageInput } from '../providers/assistant-vision.js';
import {
  assertRequestFits,
  contextLimits,
  requestTokens,
  textRequestTokens,
  ContextBudgetError,
} from '../providers/assistant-context-budget.js';
import {
  completionInputEstimate,
  financialInputAllowance,
  strictContextEnabled,
} from '../providers/assistant-context-policy.js';
import {
  contextEstimateConfig,
  observeTextUsage,
} from '../persistence/assistant-context-estimate.js';
import { LlmRequestError } from '../providers/assistant-llm-error.js';
import { assertCurrentContext } from './context.js';
import { assertScheduledTurn } from '../tasks/assistant-prompt-scheduler.js';

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
export interface MeteredCompletionArgs {
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
  forceContextBudget?: boolean;
  /** A caller can rebuild history while preserving its mandatory request and live tool exchanges. */
  rebuildContext?: (
    config: AssistantConfig,
    inputLimit: number,
  ) => LlmMessage[];
  /** Research reserves an outer synthesis slot; callers cannot increase the configured ceiling. */
  callLimit?: number;
}

function assertCallLimit(args: MeteredCompletionArgs): void {
  const limit = Math.min(
    args.config.maxCalls,
    args.callLimit ?? args.config.maxCalls,
  );
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Invalid model-call limit');
  const run = args.store.db
    .query('SELECT llm_calls FROM assistant_runs WHERE id=?')
    .get(args.taskId) as { llm_calls: number } | null;
  if (run && run.llm_calls >= limit)
    throw new BudgetExceeded(
      'Достигнут лимит обращений к модели в этой задаче. Сохранённые задания остаются в /tasks.',
    );
}

export async function meteredCompletion(
  args: MeteredCompletionArgs,
): Promise<LlmMessage> {
  let messages = args.messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    args.signal.throwIfAborted();
    assertCurrentContext(args.store, args.request);
    assertScheduledTurn(args.store, args.request);
    const config = contextEstimateConfig(args.store, args.config);
    try {
      return await meteredAttempt({ ...args, config, messages });
    } catch (error) {
      if (
        attempt ||
        !(error instanceof LlmRequestError) ||
        !error.contextOverflow ||
        !args.rebuildContext ||
        !(args.forceContextBudget || strictContextEnabled(config, args.images))
      )
        throw error;
      args.signal.throwIfAborted();
      assertCurrentContext(args.store, args.request);
      assertScheduledTurn(args.store, args.request);
      assertCallLimit(args);
      const retryKey = `context_overflow_retry:${args.taskId}`;
      if (args.store.state(retryKey)) throw error;
      // Shrink THIS request, rather than retrying an unchanged small request at half the nominal cap.
      const inputLimit = Math.floor(
        Math.min(
          contextLimits(config).input,
          requestTokens(messages, args.tools, config, args.images),
        ) / 2,
      );
      let reduced: LlmMessage[];
      try {
        reduced = args.rebuildContext(config, inputLimit);
        assertRequestFits(reduced, args.tools, config, args.images, inputLimit);
      } catch (failure) {
        if (failure instanceof ContextBudgetError) throw error;
        throw failure;
      }
      const claimed = args.store.transaction(() => {
        if (args.store.state(retryKey)) return false;
        args.store.setState(retryKey, '1');
        return true;
      });
      if (!claimed) throw error;
      messages = reduced;
      args.onContent?.('');
    }
  }
  throw new Error('Unreachable completion retry');
}

async function meteredAttempt(
  args: MeteredCompletionArgs,
): Promise<LlmMessage> {
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
  assertCallLimit(args);
  const estimatedInput = args.forceContextBudget
    ? assertRequestFits(messages, tools, config, args.images)
    : completionInputEstimate(messages, tools, config, args.images);
  const reserved =
    (Math.max(
      estimatedInput,
      financialInputAllowance(messages, tools, args.images),
    ) *
      config.inputPrice +
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
      !args.images?.length &&
      (args.forceContextBudget || strictContextEnabled(config))
    )
      observeTextUsage(
        store,
        config,
        textRequestTokens(messages, tools),
        usage?.prompt_tokens,
      );
    if (
      usage &&
      Number.isSafeInteger(usage.prompt_tokens) &&
      usage.prompt_tokens! >= 0 &&
      Number.isSafeInteger(usage.completion_tokens) &&
      usage.completion_tokens! >= 0
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
