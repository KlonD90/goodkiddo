import type { Logger } from 'pino';

import { listAvailableGroups } from '../groups/available-groups.js';
import {
  getAllTasks,
  getLatestOpenPairedTaskForChat,
} from '../persistence/db.js';
import { createScopedLogger } from '../config/logger.js';
import { buildRoomMemoryBriefing } from '../integrations/memento-client.js';
import {
  preparePairedExecutionContext,
  type PreparedPairedExecutionContext,
} from '../paired/paired-execution-context.js';
import {
  resolveActiveRole,
  resolveConfiguredRoleAgentPlan,
  resolveEffectiveAgentType,
  resolveSessionFolder,
} from './message-runtime-rules.js';
import { buildRoomRoleContext } from '../paired/room-role-context.js';
import { getRoleModelConfig, getMoaConfig } from '../config/config.js';
import {
  collectMoaReferences,
  formatMoaReferencesForPrompt,
} from '../providers/moa.js';
import { readArbiterPrompt } from '../groups/platform-prompts.js';
import { getEffectiveChannelLease } from '../paired/service-routing.js';
import { getTokenCount } from '../providers/token-rotation.js';
import {
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../agents/agent-runner.js';
import type { RegisteredGroup, RoomRoleContext } from '../shared/types.js';

export interface MessageAgentExecutorContextDeps {
  assistantName: string;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
}

export interface MessageAgentExecutorContextArgs {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  runId: string;
  startSeq?: number | null;
  endSeq?: number | null;
  hasHumanMessage?: boolean;
}

export interface ResolvedMessageAgentExecutionContext {
  isMain: boolean;
  currentLease: ReturnType<typeof getEffectiveChannelLease>;
  activeRole: ReturnType<typeof resolveActiveRole>;
  effectiveServiceId: string;
  reviewerMode: boolean;
  arbiterMode: boolean;
  effectiveAgentType: NonNullable<RegisteredGroup['agentType']>;
  effectiveGroup: RegisteredGroup;
  isClaudeCodeAgent: boolean;
  sessionFolder: string;
  sessionId: string | undefined;
  memoryBriefing: string | undefined;
  canRotateToken: boolean;
  roomRoleContext: RoomRoleContext | undefined;
  pairedExecutionContext: PreparedPairedExecutionContext | undefined;
  log: Logger;
  effectivePrompt: string;
  agentInput: {
    prompt: string;
    sessionId?: string;
    memoryBriefing?: string;
    groupFolder: string;
    chatJid: string;
    runId: string;
    isMain: boolean;
    assistantName: string;
    roomRoleContext?: RoomRoleContext;
  };
}

export async function buildMessageAgentExecutionContext(
  deps: MessageAgentExecutorContextDeps,
  args: MessageAgentExecutorContextArgs,
): Promise<ResolvedMessageAgentExecutionContext> {
  const { group, prompt, chatJid, runId, startSeq, endSeq } = args;
  const isMain = group.isMain === true;
  const sessions = deps.getSessions();

  const currentLease = getEffectiveChannelLease(chatJid);
  const pairedTask = currentLease.reviewer_service_id
    ? getLatestOpenPairedTaskForChat(chatJid)
    : null;
  const activeRole = resolveActiveRole(pairedTask?.status);
  const effectiveServiceId =
    activeRole === 'arbiter'
      ? currentLease.arbiter_service_id!
      : activeRole === 'reviewer'
        ? currentLease.reviewer_service_id!
        : currentLease.owner_service_id;
  const reviewerMode = activeRole === 'reviewer';
  const arbiterMode = activeRole === 'arbiter';
  const roleAgentPlan = resolveConfiguredRoleAgentPlan(
    currentLease.reviewer_service_id != null,
    group.agentType,
  );

  const effectiveAgentType = resolveEffectiveAgentType(
    activeRole,
    group.agentType,
  );
  const effectiveGroup =
    effectiveAgentType !== roleAgentPlan.ownerAgentType
      ? { ...group, agentType: effectiveAgentType }
      : group;
  const isClaudeCodeAgent = effectiveAgentType === 'claude-code';
  const sessionFolder = resolveSessionFolder(
    group.folder,
    activeRole,
    group.agentType,
  );
  const sessionId =
    activeRole === 'arbiter' ? undefined : sessions[sessionFolder];
  const memoryBriefing = sessionId
    ? undefined
    : await buildRoomMemoryBriefing({
        groupFolder: group.folder,
        groupName: group.name,
      }).catch(() => undefined);

  const tasks = getAllTasks(roleAgentPlan.ownerAgentType);
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((task) => ({
      id: task.id,
      groupFolder: task.group_folder,
      prompt: task.prompt,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      status: task.status,
      next_run: task.next_run,
    })),
  );

  writeGroupsSnapshot(
    group.folder,
    isMain,
    listAvailableGroups(deps.getRegisteredGroups()),
  );

  const canRotateToken = isClaudeCodeAgent && getTokenCount() > 1;
  const roomRoleContext = buildRoomRoleContext(
    currentLease,
    effectiveServiceId,
    activeRole,
  );
  const pairedExecutionContext = preparePairedExecutionContext({
    group,
    chatJid,
    runId,
    roomRoleContext,
    hasHumanMessage: args.hasHumanMessage,
  });

  if (pairedExecutionContext) {
    const roleConfig = getRoleModelConfig(activeRole);
    if (roleConfig.model) {
      const modelKey = isClaudeCodeAgent ? 'CLAUDE_MODEL' : 'CODEX_MODEL';
      pairedExecutionContext.envOverrides[modelKey] = roleConfig.model;
    }
    if (roleConfig.effort) {
      const effortKey = isClaudeCodeAgent ? 'CLAUDE_EFFORT' : 'CODEX_EFFORT';
      pairedExecutionContext.envOverrides[effortKey] = roleConfig.effort;
    }
  }

  const log = createScopedLogger({
    chatJid,
    groupName: group.name,
    groupFolder: group.folder,
    runId,
    messageSeqStart: startSeq ?? undefined,
    messageSeqEnd: endSeq ?? undefined,
    role: activeRole,
    serviceId: effectiveServiceId,
  });

  let effectivePrompt = prompt;
  const moaConfig = getMoaConfig();
  if (arbiterMode && moaConfig.enabled && pairedExecutionContext) {
    log.info(
      {
        models: moaConfig.referenceModels.map((model) => model.name),
      },
      'MoA: collecting reference opinions before arbiter',
    );

    const systemPrompt =
      readArbiterPrompt(process.cwd()) || 'You are an arbiter.';

    const references = await collectMoaReferences({
      config: moaConfig,
      systemPrompt,
      contextPrompt: prompt,
    });

    const moaSection = formatMoaReferencesForPrompt(references);
    if (moaSection) {
      effectivePrompt = prompt + '\n' + moaSection;
      log.info(
        {
          successCount: references.filter((reference) => !reference.error)
            .length,
          totalCount: references.length,
        },
        'MoA: injected reference opinions into arbiter prompt',
      );
    }
  }

  return {
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
    effectivePrompt,
    agentInput: {
      prompt: effectivePrompt,
      sessionId,
      memoryBriefing,
      groupFolder: group.folder,
      chatJid,
      runId,
      isMain,
      assistantName: deps.assistantName,
      roomRoleContext,
    },
  };
}
