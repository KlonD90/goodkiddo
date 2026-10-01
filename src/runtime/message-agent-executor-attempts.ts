import type { Logger } from 'pino';

import { getErrorMessage } from '../shared/utils.js';
import { getAgentOutputText } from '../agents/agent-output.js';
import { type AgentOutput, runAgentProcess } from '../agents/agent-runner.js';
import { shouldResetSessionOnAgentFailure } from '../agents/session-recovery.js';
import { type AgentTriggerReason } from '../agents/agent-error-detection.js';
import {
  evaluateStreamedOutput,
  type StreamedOutputState,
} from '../providers/streamed-output-evaluator.js';
import {
  detectCodexRotationTrigger,
  rotateCodexToken,
  getCodexAccountCount,
  markCodexTokenHealthy,
} from '../providers/codex-token-rotation.js';
import { runClaudeRotationLoop } from '../providers/provider-retry.js';
import type { CodexRotationReason } from '../agents/agent-error-detection.js';
import type { PreparedPairedExecutionContext } from '../paired/paired-execution-context.js';
import type { RegisteredGroup } from '../shared/types.js';

export interface MessageAgentAttemptResult {
  output?: AgentOutput;
  error?: unknown;
  sawOutput: boolean;
  sawVisibleOutput: boolean;
  sawSuccessNullResultWithoutOutput: boolean;
  retryableSessionFailureDetected: boolean;
  streamedTriggerReason?: {
    reason: AgentTriggerReason;
    retryAfterMs?: number;
  };
}

export interface MessageAgentAttemptState {
  resetSessionRequested: boolean;
  pairedExecutionSummary: string | null;
  pairedFullOutput: string | null;
  pairedSawOutput: boolean;
}

export interface CreateMessageAgentAttemptRunnerOptions {
  log: Logger;
  effectiveAgentType: NonNullable<RegisteredGroup['agentType']>;
  effectiveGroup: RegisteredGroup;
  executionAgentInput: {
    prompt: string;
    sessionId?: string;
    memoryBriefing?: string;
    groupFolder: string;
    chatJid: string;
    runId: string;
    isMain: boolean;
    assistantName: string;
    roomRoleContext?: import('../shared/types.js').RoomRoleContext;
  };
  sessionId?: string;
  sessionFolder: string;
  chatJid: string;
  canRotateToken: boolean;
  isClaudeCodeAgent: boolean;
  pairedExecutionContext?: PreparedPairedExecutionContext;
  queueRegisterProcess: (
    chatJid: string,
    proc: import('child_process').ChildProcess,
    processName: string,
    ipcDir: string,
  ) => void;
  persistSession: (groupFolder: string, sessionId: string) => void;
  onOutput?: (output: AgentOutput) => Promise<void>;
  state: MessageAgentAttemptState;
}

export function createMessageAgentAttemptRunner(
  options: CreateMessageAgentAttemptRunnerOptions,
): (provider: string) => Promise<MessageAgentAttemptResult> {
  return async (provider: string): Promise<MessageAgentAttemptResult> => {
    let streamedState: StreamedOutputState = {
      sawOutput: false,
      sawVisibleOutput: false,
      sawSuccessNullResultWithoutOutput: false,
    };

    const wrappedOnOutput = options.onOutput
      ? async (output: AgentOutput) => {
          if (
            options.isClaudeCodeAgent &&
            provider === 'claude' &&
            shouldResetSessionOnAgentFailure(output)
          ) {
            options.state.resetSessionRequested = true;
          }
          if (
            provider === 'claude' &&
            output.newSessionId &&
            !options.state.resetSessionRequested
          ) {
            options.persistSession(options.sessionFolder, output.newSessionId);
          }
          const evaluation = evaluateStreamedOutput(output, streamedState, {
            agentType: options.isClaudeCodeAgent ? 'claude-code' : 'codex',
            provider,
            suppressClaudeAuthErrorOutput: provider === 'claude',
            trackSuccessNullResult: true,
            shortCircuitTriggeredErrors:
              provider === 'claude'
                ? options.canRotateToken
                : getCodexAccountCount() > 1,
          });
          streamedState = evaluation.state;

          const outputText = getAgentOutputText(output);
          if (typeof outputText === 'string' && outputText.length > 0) {
            options.state.pairedExecutionSummary = outputText.slice(0, 500);
            options.state.pairedFullOutput = outputText;
          } else if (
            typeof output.error === 'string' &&
            output.error.length > 0
          ) {
            options.state.pairedExecutionSummary = output.error.slice(0, 500);
          }
          if (
            evaluation.newTrigger &&
            typeof outputText === 'string' &&
            output.status === 'success'
          ) {
            options.log.warn(
              {
                reason: evaluation.newTrigger.reason,
                resultPreview: outputText.slice(0, 120),
              },
              'Detected Claude rotation trigger in successful output',
            );
          } else if (
            evaluation.newTrigger &&
            typeof output.error === 'string'
          ) {
            options.log.warn(
              {
                reason: evaluation.newTrigger.reason,
                errorPreview: output.error.slice(0, 120),
              },
              provider === 'claude'
                ? 'Detected Claude rotation trigger in streamed error output'
                : 'Detected Codex rotation trigger in streamed error output',
            );
          }

          if (evaluation.suppressedAuthError) {
            options.log.warn(
              {
                resultPreview:
                  typeof outputText === 'string'
                    ? outputText.slice(0, 120)
                    : undefined,
              },
              'Suppressed Claude 401 auth error from chat output',
            );
            return;
          }

          if (evaluation.suppressedRetryableSessionFailure) {
            options.log.warn(
              {
                resultPreview:
                  typeof outputText === 'string'
                    ? outputText.slice(0, 160)
                    : output.error?.slice(0, 160),
              },
              'Suppressed retryable Claude session failure from chat output',
            );
            return;
          }

          if (!evaluation.shouldForwardOutput) {
            return;
          }
          if (typeof outputText === 'string' && outputText.length > 0) {
            streamedState = {
              ...evaluation.state,
              sawVisibleOutput: true,
            };
          }
          await options.onOutput?.(output);
        }
      : undefined;

    const providerLog = options.log.child({
      provider,
      agentType: options.effectiveAgentType,
    });
    providerLog.info('Using provider');

    try {
      const output = await runAgentProcess(
        options.effectiveGroup,
        {
          ...options.executionAgentInput,
          sessionId: provider === 'claude' ? options.sessionId : undefined,
        },
        (proc, processName, ipcDir) =>
          options.queueRegisterProcess(
            options.chatJid,
            proc,
            processName,
            ipcDir,
          ),
        wrappedOnOutput,
        options.pairedExecutionContext?.envOverrides,
      );

      if (provider === 'claude' && output.newSessionId) {
        options.persistSession(options.sessionFolder, output.newSessionId);
      }

      providerLog.info(
        {
          status: output.status,
          sawOutput: streamedState.sawOutput,
        },
        `Provider response completed (provider: ${provider})`,
      );

      return {
        output,
        sawOutput: streamedState.sawOutput,
        sawVisibleOutput: streamedState.sawVisibleOutput,
        sawSuccessNullResultWithoutOutput:
          streamedState.sawSuccessNullResultWithoutOutput,
        retryableSessionFailureDetected:
          streamedState.retryableSessionFailureDetected === true,
        streamedTriggerReason: streamedState.streamedTriggerReason,
      };
    } catch (error) {
      return {
        error,
        sawOutput: streamedState.sawOutput,
        sawVisibleOutput: streamedState.sawVisibleOutput,
        sawSuccessNullResultWithoutOutput:
          streamedState.sawSuccessNullResultWithoutOutput,
        retryableSessionFailureDetected:
          streamedState.retryableSessionFailureDetected === true,
        streamedTriggerReason: streamedState.streamedTriggerReason,
      };
    }
  };
}

export async function retryCodexWithRotation(args: {
  log: Logger;
  runAttempt: (provider: string) => Promise<MessageAgentAttemptResult>;
  initialTrigger: { reason: CodexRotationReason };
  rotationMessage?: string;
}): Promise<'success' | 'error'> {
  let trigger = args.initialTrigger;
  let lastRotationMessage = args.rotationMessage;

  while (getCodexAccountCount() > 1 && rotateCodexToken(lastRotationMessage)) {
    args.log.info(
      { reason: trigger.reason },
      'Codex account unhealthy, retrying with rotated account',
    );

    const retryAttempt = await args.runAttempt('codex');

    if (retryAttempt.error) {
      const errMsg = getErrorMessage(retryAttempt.error);
      const retryTrigger = detectCodexRotationTrigger(errMsg);
      if (retryTrigger.shouldRotate) {
        trigger = { reason: retryTrigger.reason };
        lastRotationMessage = errMsg;
        continue;
      }

      args.log.error(
        { provider: 'codex', err: retryAttempt.error },
        'Rotated Codex account also threw',
      );
      return 'error';
    }

    const retryOutput = retryAttempt.output;
    if (!retryOutput) {
      args.log.error(
        { provider: 'codex' },
        'Rotated Codex account produced no output object',
      );
      return 'error';
    }

    if (
      !retryAttempt.sawOutput &&
      retryAttempt.streamedTriggerReason &&
      retryOutput.status !== 'error'
    ) {
      trigger = {
        reason: retryAttempt.streamedTriggerReason
          .reason as CodexRotationReason,
      };
      lastRotationMessage =
        typeof retryOutput.result === 'string' ? retryOutput.result : undefined;
      continue;
    }

    if (retryOutput.status === 'error') {
      const retryTrigger = retryAttempt.streamedTriggerReason
        ? {
            shouldRotate: true,
            reason: retryAttempt.streamedTriggerReason
              .reason as CodexRotationReason,
          }
        : detectCodexRotationTrigger(retryOutput.error);

      if (retryTrigger.shouldRotate) {
        trigger = { reason: retryTrigger.reason };
        lastRotationMessage = retryOutput.error ?? undefined;
        continue;
      }

      args.log.error(
        {
          provider: 'codex',
          error: retryOutput.error,
        },
        'Rotated Codex account failed',
      );
      return 'error';
    }

    markCodexTokenHealthy();
    return 'success';
  }

  return 'error';
}

export async function retryClaudeWithRotation(args: {
  log: Logger;
  chatJid: string;
  groupName: string;
  groupFolder: string;
  runId: string;
  runAttempt: (provider: string) => Promise<MessageAgentAttemptResult>;
  initialTrigger: {
    reason: AgentTriggerReason;
    retryAfterMs?: number;
  };
  rotationMessage?: string;
  state: MessageAgentAttemptState;
}): Promise<'success' | 'error'> {
  const logCtx = {
    chatJid: args.chatJid,
    group: args.groupName,
    groupFolder: args.groupFolder,
    runId: args.runId,
  };

  const outcome = await runClaudeRotationLoop(
    args.initialTrigger,
    async () => {
      const attempt = await args.runAttempt('claude');
      return {
        output: attempt.output,
        thrownError: attempt.error,
        sawOutput: attempt.sawOutput,
        sawSuccessNullResult: attempt.sawSuccessNullResultWithoutOutput,
        streamedTriggerReason: attempt.streamedTriggerReason,
      };
    },
    logCtx,
    args.rotationMessage,
  );

  switch (outcome.type) {
    case 'success':
      args.state.pairedSawOutput = outcome.sawOutput;
      return 'success';
    case 'error':
      return 'error';
  }
}
