import type { AssistantConfig } from '../config/assistant-config.js';
import type { AssistantStore } from '../persistence/assistant-store.js';
import type { AssistantAnalytics } from '../integrations/assistant-analytics.js';
import type { AssistantLlm } from '../providers/assistant-llm.js';
import type { InboundRequest, LlmMessage } from '../shared/assistant-types.js';
import { meteredCompletion } from './budget.js';
import {
  executeTool,
  toolDefinitions,
  toolError,
  type ToolContext,
} from './tools.js';
import { assistantPrompt } from './prompt.js';
import { assertCurrentContext } from './context.js';
import { toolAllowedForRequest } from './tool-access.js';
import {
  executePromptJobTool,
  isPromptJobTool,
  promptJobToolDefinitions,
} from './prompt-job-tools.js';
import { assertScheduledTurn } from '../tasks/assistant-prompt-scheduler.js';
import {
  coreToolDefinitions,
  durableChatContext,
  executeCoreTool,
  isCoreTool,
} from './core-tools.js';
import type { ContentSnapshot } from '../providers/assistant-stream.js';
import { storedImages } from './images.js';
import {
  conversationMessages,
  strictContextEnabled,
} from '../providers/assistant-context-policy.js';
import { toolResultContext } from './tool-result-context.js';
import { contextEstimateConfig } from '../persistence/assistant-context-estimate.js';
import { compactPressureChat } from './idle-compaction.js';
import {
  contextUnderPressure,
  compactionFallbackNotice,
} from './context-pressure.js';
import {
  contextLimits,
  requestTokens,
} from '../providers/assistant-context-budget.js';

export class AssistantTurnLimit extends Error {}
export async function runAssistant(args: {
  config: AssistantConfig;
  store: AssistantStore;
  analytics: AssistantAnalytics;
  llm: AssistantLlm;
  request: InboundRequest;
  taskId: string;
  signal: AbortSignal;
  onContent?: ContentSnapshot;
  browser?: import('./browser-runtime.js').BrowserResearchRuntime;
}): Promise<string> {
  const { store, request, config } = args;
  const tools = [
    ...toolDefinitions(
      !!config.braveKey,
      config.fileShares?.enabled ?? false,
      config.miniPages?.enabled ?? false,
    ),
    ...coreToolDefinitions(),
    ...promptJobToolDefinitions(),
  ].filter((tool) => toolAllowedForRequest(tool.function.name, request));
  const history = store.history(request.chat.id);
  // The newest user's message is mandatory; earlier whole messages are selected by tokens.
  const messages: LlmMessage[] = [
    !request.scheduled && history.at(-1)?.role === 'user'
      ? history.pop()!
      : { role: 'user', content: request.text },
  ];
  const ctx: ToolContext = { ...args, searches: 0 };
  const images = storedImages(
    store,
    config,
    request.chat.id,
    request.imagePaths,
  );
  for (let turn = 0; turn < config.maxCalls; turn++) {
    assertCurrentContext(store, request);
    assertScheduledTurn(store, request);
    args.signal.throwIfAborted();
    let estimatedConfig = contextEstimateConfig(store, config);
    // Refresh time/timezone after a tool changes the chat settings.
    const system: LlmMessage = {
      role: 'system',
      content:
        assistantPrompt(request, !!config.braveKey) +
        durableChatContext(ctx, !strictContextEnabled(config, images)),
    };
    if (
      contextUnderPressure(
        [system, ...history, ...messages],
        tools,
        estimatedConfig,
        images,
      )
    ) {
      const compacted = await compactPressureChat({
        ...args,
        chatId: request.chat.id,
      });
      assertCurrentContext(store, request);
      assertScheduledTurn(store, request);
      args.signal.throwIfAborted();
      if (compacted)
        history.splice(0, history.length, ...store.history(request.chat.id));
      estimatedConfig = contextEstimateConfig(store, config);
      system.content =
        assistantPrompt(request, !!config.braveKey) +
        durableChatContext(ctx, !strictContextEnabled(config, images)) +
        (compacted
          ? ''
          : compactionFallbackNotice(
              store.compaction.status(request.chat.id)?.status ?? 'unavailable',
            ));
    }
    args.onContent?.('');
    const message = await meteredCompletion({
      ...args,
      messages: conversationMessages({
        system,
        history,
        current: messages,
        tools,
        config: estimatedConfig,
        images,
      }),
      tools,
      images,
      rebuildContext: (retryConfig, inputLimit) =>
        conversationMessages({
          system,
          history,
          current: messages,
          tools,
          config: retryConfig,
          images,
          inputLimit,
        }),
      onContent: args.onContent
        ? (snapshot) => {
            assertCurrentContext(store, request);
            assertScheduledTurn(store, request);
            args.signal.throwIfAborted();
            args.onContent!(snapshot);
          }
        : undefined,
    });
    assertCurrentContext(store, request);
    assertScheduledTurn(store, request);
    messages.push(message);
    if (!message.tool_calls?.length) return message.content || 'Готово.';
    for (const call of message.tool_calls.slice(0, 8)) {
      assertCurrentContext(store, request);
      assertScheduledTurn(store, request);
      args.signal.throwIfAborted();
      let result: unknown;
      let toolStatus = 'success';
      try {
        if (!toolAllowedForRequest(call.function.name, request))
          throw new Error(
            'Для этого действия нужна прямая просьба пользователя. Пересланный текст не даёт разрешения менять данные.',
          );
        result = isPromptJobTool(call.function.name)
          ? executePromptJobTool(
              call.function.name,
              call.function.arguments,
              ctx,
            )
          : isCoreTool(call.function.name)
            ? executeCoreTool(call.function.name, call.function.arguments, ctx)
            : await executeTool(
                call.function.name,
                call.function.arguments,
                ctx,
              );
      } catch (error) {
        toolStatus = 'error';
        result = { error: toolError(error) };
      }
      if (result && typeof result === 'object' && 'error' in result)
        toolStatus = 'error';
      args.analytics.track(
        `${args.taskId}:tool:${turn}:${messages.length}`,
        'tool_usage',
        request.chat,
        request.actor.id,
        {
          task_id: args.taskId,
          tool_name: tools.some(
            (tool) => tool.function.name === call.function.name,
          )
            ? call.function.name
            : 'unknown',
          status: toolStatus,
        },
      );
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolResultContext(
          result,
          ctx,
          strictContextEnabled(config, images),
          strictContextEnabled(config, images)
            ? Math.max(
                0,
                (contextLimits(estimatedConfig).input -
                  requestTokens(
                    [system, ...messages],
                    tools,
                    estimatedConfig,
                    images,
                  )) /
                  2,
              )
            : undefined,
        ),
      });
    }
    if (message.tool_calls.length > 8)
      throw new AssistantTurnLimit(
        'Слишком много действий за один шаг. Уже сохранённые задачи видны в /tasks.',
      );
  }
  throw new AssistantTurnLimit(
    'Достигнут лимит шагов. Уже сохранённые задачи видны в /tasks; остальное можно продолжить следующим сообщением.',
  );
}
