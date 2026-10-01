import { getErrorMessage } from '../shared/utils.js';

import {
  getAgentOutputText,
  getStructuredAgentOutput,
} from '../agents/agent-output.js';
import { AgentOutput } from '../agents/agent-runner.js';
import {
  createServiceHandoff,
  getLastHumanMessageSender,
  getLatestTurnNumber,
  getPairedTaskById,
  insertPairedTurnOutput,
} from '../persistence/db.js';
import { GroupQueue } from '../runtime/group-queue.js';
import { completePairedExecutionContext } from '../paired/paired-execution-context.js';
import {
  classifyRotationTrigger,
  type AgentTriggerReason,
} from '../agents/agent-error-detection.js';
import {
  shouldResetSessionOnAgentFailure,
  shouldRetryFreshSessionOnAgentFailure,
} from '../agents/session-recovery.js';
import {
  CODEX_REVIEW_SERVICE_ID,
  SERVICE_SESSION_SCOPE,
  getRoleModelConfig,
} from '../config/config.js';
import { activateCodexFailover } from '../paired/service-routing.js';
import {
  detectCodexRotationTrigger,
  getCodexAccountCount,
} from '../providers/codex-token-rotation.js';
import type { CodexRotationReason } from '../agents/agent-error-detection.js';
import type { RegisteredGroup } from '../shared/types.js';
import { buildMessageAgentExecutionContext } from './message-agent-executor-context.js';
import {
  createMessageAgentAttemptRunner,
  retryClaudeWithRotation,
  retryCodexWithRotation,
  type MessageAgentAttemptState,
} from './message-agent-executor-attempts.js';

// ── Main executor ─────────────────────────────────────────────────

export interface MessageAgentExecutorDeps {
  assistantName: string;
  queue: Pick<GroupQueue, 'registerProcess' | 'enqueueMessageCheck'>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  persistSession: (groupFolder: string, sessionId: string) => void;
  clearSession: (groupFolder: string) => void;
}

export async function runAgentForGroup(
  deps: MessageAgentExecutorDeps,
  args: {
    group: RegisteredGroup;
    prompt: string;
    chatJid: string;
    runId: string;
    startSeq?: number | null;
    endSeq?: number | null;
    hasHumanMessage?: boolean;
    onOutput?: (output: AgentOutput) => Promise<void>;
  },
): Promise<'success' | 'error'> {
  const { group, prompt, chatJid, runId, startSeq, endSeq, onOutput } = args;
  const {
    isMain,
    currentLease,
    activeRole,
    effectiveServiceId,
    reviewerMode,
    arbiterMode,
    effectiveAgentType,
    effectiveGroup,
    isClaudeCodeAgent,
    sessionFolder,
    sessionId,
    memoryBriefing,
    canRotateToken,
    roomRoleContext,
    pairedExecutionContext,
    log,
    agentInput: executionAgentInput,
  } = await buildMessageAgentExecutionContext(deps, args);
  let resetSessionRequested = false;
  let pairedExecutionStatus: 'succeeded' | 'failed' = 'failed';
  const attemptState: MessageAgentAttemptState = {
    resetSessionRequested: false,
    pairedExecutionSummary: null,
    pairedFullOutput: null,
    pairedSawOutput: false,
  };
  let pairedExecutionCompleted = false;

  const shouldHandoffToCodex = (
    reason: AgentTriggerReason,
    sawVisibleOutput: boolean,
  ): boolean => {
    if (sawVisibleOutput) {
      return false;
    }
    return (
      reason === '429' ||
      reason === 'usage-exhausted' ||
      reason === 'auth-expired' ||
      reason === 'org-access-denied'
    );
  };

  const maybeHandoffToCodex = (
    reason: AgentTriggerReason,
    sawVisibleOutput: boolean,
  ): boolean => {
    if (!isClaudeCodeAgent) return false;
    if (!shouldHandoffToCodex(reason, sawVisibleOutput)) {
      return false;
    }
    if (currentLease.reviewer_service_id === null) {
      return false;
    }
    // Per-role fallback toggle
    const roleConfig = getRoleModelConfig(activeRole);
    if (!roleConfig.fallbackEnabled) {
      log.info({ reason }, 'Fallback disabled for role, skipping handoff');
      return false;
    }

    if (arbiterMode) {
      // Arbiter failed (e.g. Claude 401/429) — re-trigger arbitration with codex
      createServiceHandoff({
        chat_jid: chatJid,
        group_folder: group.folder,
        source_service_id: SERVICE_SESSION_SCOPE,
        target_service_id: CODEX_REVIEW_SERVICE_ID,
        target_agent_type: 'codex',
        prompt,
        start_seq: startSeq ?? null,
        end_seq: endSeq ?? null,
        reason: `arbiter-claude-${reason}`,
      });
      log.warn(
        { reason },
        'Claude arbiter unavailable, handed off arbiter turn to codex',
      );
      return true;
    }

    if (reviewerMode) {
      // Reviewer failed (e.g. Claude 401/429) — re-trigger review with codex
      // instead of swapping owner/reviewer roles.
      createServiceHandoff({
        chat_jid: chatJid,
        group_folder: group.folder,
        source_service_id: SERVICE_SESSION_SCOPE,
        target_service_id: CODEX_REVIEW_SERVICE_ID,
        target_agent_type: 'codex',
        prompt,
        start_seq: startSeq ?? null,
        end_seq: endSeq ?? null,
        reason: `reviewer-claude-${reason}`,
      });
      log.warn(
        { reason },
        'Claude reviewer unavailable, handed off review turn to codex-review',
      );
      return true;
    }

    activateCodexFailover(chatJid, `claude-${reason}`);
    createServiceHandoff({
      chat_jid: chatJid,
      group_folder: group.folder,
      source_service_id: SERVICE_SESSION_SCOPE,
      target_service_id: CODEX_REVIEW_SERVICE_ID,
      target_agent_type: 'codex',
      prompt,
      start_seq: startSeq ?? null,
      end_seq: endSeq ?? null,
      reason: `claude-${reason}`,
    });
    log.warn(
      { reason },
      'Claude unavailable, handed off current turn to codex-review',
    );
    return true;
  };

  if (pairedExecutionContext?.blockMessage) {
    attemptState.pairedExecutionSummary =
      pairedExecutionContext.blockMessage.slice(0, 500);
    log.warn(
      {
        roomRoleServiceId: roomRoleContext?.serviceId,
        roomRole: roomRoleContext?.role,
      },
      'Blocked reviewer execution before review-ready snapshot was available',
    );
    await onOutput?.({
      status: 'success',
      result: null,
      output: {
        visibility: 'public',
        text: pairedExecutionContext.blockMessage,
      },
      phase: 'final',
    });
    completePairedExecutionContext({
      taskId: pairedExecutionContext.task.id,
      role: roomRoleContext?.role ?? 'owner',
      status: pairedExecutionStatus,
      summary: attemptState.pairedExecutionSummary,
    });
    pairedExecutionCompleted = true;
    return 'success';
  }

  const runAttempt = createMessageAgentAttemptRunner({
    log,
    effectiveAgentType,
    effectiveGroup,
    executionAgentInput,
    sessionId,
    sessionFolder,
    chatJid,
    canRotateToken,
    isClaudeCodeAgent,
    pairedExecutionContext,
    queueRegisterProcess: (registeredChatJid, proc, processName, ipcDir) =>
      deps.queue.registerProcess(registeredChatJid, proc, processName, ipcDir),
    persistSession: deps.persistSession,
    onOutput,
    state: attemptState,
  });

  const maybeHandoffAfterError = (
    reason: AgentTriggerReason,
    attempt: Awaited<ReturnType<typeof runAttempt>>,
  ): 'success' | 'error' => {
    if (maybeHandoffToCodex(reason, attempt.sawVisibleOutput)) {
      return 'success';
    }
    return 'error';
  };

  const provider = 'claude';

  try {
    let primaryAttempt = await runAttempt(provider);

    const isRetryableClaudeSessionFailure = (
      attempt: Awaited<ReturnType<typeof runAttempt>>,
    ): boolean =>
      isClaudeCodeAgent &&
      provider === 'claude' &&
      !attempt.sawOutput &&
      (attempt.retryableSessionFailureDetected === true ||
        (attempt.error != null &&
          shouldRetryFreshSessionOnAgentFailure({
            result: null,
            error: getErrorMessage(attempt.error),
          })));

    if (isRetryableClaudeSessionFailure(primaryAttempt)) {
      deps.clearSession(sessionFolder);
      log.warn(
        'Cleared poisoned Claude session before visible output, retrying fresh session',
      );

      primaryAttempt = await runAttempt('claude');

      if (isRetryableClaudeSessionFailure(primaryAttempt)) {
        deps.clearSession(sessionFolder);
        log.warn('Fresh Claude retry also hit a retryable session failure');

        log.error(
          'Retryable Claude session failure persisted after fresh retry',
        );
        return 'error';
      }
    }

    if (primaryAttempt.error) {
      if (
        canRotateToken &&
        provider === 'claude' &&
        !primaryAttempt.sawOutput
      ) {
        const errMsg = getErrorMessage(primaryAttempt.error);
        const trigger = primaryAttempt.streamedTriggerReason
          ? {
              shouldRetry: true,
              reason: primaryAttempt.streamedTriggerReason.reason,
              retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
            }
          : classifyRotationTrigger(errMsg);
        if (trigger.shouldRetry) {
          const result = await retryClaudeWithRotation({
            log,
            chatJid,
            groupName: group.name,
            groupFolder: group.folder,
            runId,
            runAttempt,
            initialTrigger: {
              reason: trigger.reason,
              retryAfterMs: trigger.retryAfterMs,
            },
            rotationMessage: errMsg,
            state: attemptState,
          });
          if (result === 'error') {
            return maybeHandoffAfterError(trigger.reason, primaryAttempt);
          }
          if (result === 'success') {
            pairedExecutionStatus = 'succeeded';
          }
          return result;
        }
      }

      if (!isClaudeCodeAgent) {
        const errMsg = getErrorMessage(primaryAttempt.error);
        const trigger = detectCodexRotationTrigger(errMsg);
        if (trigger.shouldRotate && getCodexAccountCount() > 1) {
          const result = await retryCodexWithRotation({
            log,
            runAttempt,
            initialTrigger: { reason: trigger.reason },
            rotationMessage: errMsg,
          });
          if (result === 'success') {
            pairedExecutionStatus = 'succeeded';
          }
          return result;
        }
      }

      log.error(
        {
          provider,
          err: primaryAttempt.error,
        },
        'Agent error',
      );
      return 'error';
    }

    const output = primaryAttempt.output;
    if (!output) {
      log.error({ provider }, 'Agent produced no output object');
      return 'error';
    }

    if (!attemptState.pairedExecutionSummary) {
      const finalOutputText = getAgentOutputText(output);
      attemptState.pairedExecutionSummary =
        (typeof finalOutputText === 'string' && finalOutputText.length > 0
          ? finalOutputText.slice(0, 500)
          : null) ??
        (typeof output.error === 'string' && output.error.length > 0
          ? output.error.slice(0, 500)
          : null);
    }

    if (
      canRotateToken &&
      provider === 'claude' &&
      !primaryAttempt.sawOutput &&
      primaryAttempt.streamedTriggerReason &&
      output.status !== 'error'
    ) {
      const result = await retryClaudeWithRotation({
        log,
        chatJid,
        groupName: group.name,
        groupFolder: group.folder,
        runId,
        runAttempt,
        initialTrigger: {
          reason: primaryAttempt.streamedTriggerReason.reason,
          retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
        },
        state: attemptState,
      });
      if (result === 'error') {
        return maybeHandoffAfterError(
          primaryAttempt.streamedTriggerReason.reason,
          primaryAttempt,
        );
      }
      return result;
    }

    if (
      isClaudeCodeAgent &&
      (attemptState.resetSessionRequested ||
        shouldResetSessionOnAgentFailure(output))
    ) {
      deps.clearSession(sessionFolder);
      log.warn(
        { sessionFolder },
        'Cleared poisoned agent session after unrecoverable error',
      );
    }

    if (output.status === 'error') {
      if (
        canRotateToken &&
        provider === 'claude' &&
        !primaryAttempt.sawOutput
      ) {
        const trigger = primaryAttempt.streamedTriggerReason
          ? {
              shouldRetry: true,
              reason: primaryAttempt.streamedTriggerReason.reason,
              retryAfterMs: primaryAttempt.streamedTriggerReason.retryAfterMs,
            }
          : classifyRotationTrigger(output.error);
        if (trigger.shouldRetry) {
          const result = await retryClaudeWithRotation({
            log,
            chatJid,
            groupName: group.name,
            groupFolder: group.folder,
            runId,
            runAttempt,
            initialTrigger: {
              reason: trigger.reason,
              retryAfterMs: trigger.retryAfterMs,
            },
            rotationMessage: output.error ?? undefined,
            state: attemptState,
          });
          if (result === 'error') {
            return maybeHandoffAfterError(trigger.reason, primaryAttempt);
          }
          if (result === 'success') {
            pairedExecutionStatus = 'succeeded';
          }
          return result;
        }
      }

      if (!isClaudeCodeAgent && getCodexAccountCount() > 1) {
        const trigger = detectCodexRotationTrigger(output.error);
        if (trigger.shouldRotate) {
          const result = await retryCodexWithRotation({
            log,
            runAttempt,
            initialTrigger: { reason: trigger.reason },
            rotationMessage: output.error ?? undefined,
          });
          if (result === 'success') {
            pairedExecutionStatus = 'succeeded';
          }
          return result;
        }
      }

      log.error(
        {
          provider,
          error: output.error,
        },
        'Agent process error',
      );
      return 'error';
    }

    if (
      !isClaudeCodeAgent &&
      primaryAttempt.streamedTriggerReason &&
      getCodexAccountCount() > 1
    ) {
      const result = await retryCodexWithRotation({
        log,
        runAttempt,
        initialTrigger: {
          reason: primaryAttempt.streamedTriggerReason
            .reason as CodexRotationReason,
        },
        rotationMessage: output.error ?? output.result ?? undefined,
      });
      if (result === 'success') {
        pairedExecutionStatus = 'succeeded';
      }
      return result;
    }

    // Unresolved streamed trigger — rotation was unavailable or output was
    // already forwarded.  Surfaces as an error since there is no alternative provider.
    if (primaryAttempt.streamedTriggerReason) {
      if (
        isClaudeCodeAgent &&
        maybeHandoffToCodex(
          primaryAttempt.streamedTriggerReason.reason,
          primaryAttempt.sawVisibleOutput,
        )
      ) {
        return 'success';
      }
      log.error(
        {
          reason: primaryAttempt.streamedTriggerReason.reason,
        },
        'Agent trigger detected but could not be resolved',
      );
      return 'error';
    }

    // success-null-result with no visible output — agent returned nothing useful.
    // But if output was already delivered to Discord (sawOutput), treat as success.
    if (
      primaryAttempt.sawSuccessNullResultWithoutOutput &&
      !primaryAttempt.sawOutput
    ) {
      log.error(
        'Agent returned success with null result and no visible output',
      );
      return 'error';
    }

    pairedExecutionStatus = 'succeeded';
    attemptState.pairedSawOutput = primaryAttempt.sawOutput;
    return 'success';
  } finally {
    if (pairedExecutionContext && !pairedExecutionCompleted) {
      const completedRole = roomRoleContext?.role ?? 'owner';
      // Owner was interrupted without producing output (e.g. /stop) —
      // treat as failed so reviewer is not auto-triggered.
      const effectiveStatus =
        completedRole === 'owner' &&
        pairedExecutionStatus === 'succeeded' &&
        !attemptState.pairedSawOutput
          ? 'failed'
          : pairedExecutionStatus;
      completePairedExecutionContext({
        taskId: pairedExecutionContext.task.id,
        role: completedRole,
        status: effectiveStatus,
        summary: attemptState.pairedExecutionSummary,
      });

      // Store full output for direct inter-agent data passing (Discord-independent).
      if (attemptState.pairedFullOutput && effectiveStatus === 'succeeded') {
        try {
          const turnNumber =
            getLatestTurnNumber(pairedExecutionContext.task.id) + 1;
          insertPairedTurnOutput(
            pairedExecutionContext.task.id,
            turnNumber,
            completedRole,
            attemptState.pairedFullOutput,
          );
        } catch (err) {
          log.warn(
            { pairedTaskId: pairedExecutionContext.task.id, err },
            'Failed to store paired turn output',
          );
        }
      }
    }

    // Notify user when paired task reaches a terminal state that requires attention.
    if (pairedExecutionContext) {
      const finishedTask = getPairedTaskById(pairedExecutionContext.task.id);
      if (
        finishedTask?.status === 'completed' &&
        finishedTask.completion_reason
      ) {
        const sender = getLastHumanMessageSender(chatJid);
        const mention = sender ? `<@${sender}>` : '';
        const notifications: Record<string, string> = {
          done: `${mention} ✅ 작업 완료.`,
          escalated: `${mention} ⚠️ 자동 해결 불가 — 확인이 필요합니다.`,
          arbiter_escalated: `${mention} ⚠️ 중재자 판단: 사람 개입이 필요합니다.`,
        };
        const message = notifications[finishedTask.completion_reason];
        if (message) {
          await args.onOutput?.({
            status: 'success',
            result: message,
            output: { visibility: 'public', text: message },
            phase: 'final',
          });
        }
      }
    }

    // After owner/reviewer completes, enqueue the next turn so
    // the message loop picks it up without waiting for a new message.
    // Skip if: no output (interrupted), or task already completed (ESCALATE, done, etc.)
    if (
      pairedExecutionContext &&
      pairedExecutionStatus === 'succeeded' &&
      attemptState.pairedSawOutput
    ) {
      const finishedCheck = getPairedTaskById(pairedExecutionContext.task.id);
      if (finishedCheck?.status !== 'completed') {
        deps.queue.enqueueMessageCheck(chatJid);
      }
    }
  }
}
