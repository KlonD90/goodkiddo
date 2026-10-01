import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config/config.js';
import { logger } from '../config/logger.js';
import type {
  AgentConfig,
  AgentIdentityConfig,
  GlobalAgentConfig,
  PairedRoomRole,
  RegisteredGroup,
} from '../shared/types.js';

const GLOBAL_AGENT_CONFIG_FILE = 'agent-config.json';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function parseIdentity(value: unknown): AgentIdentityConfig | undefined {
  if (!isPlainObject(value)) return undefined;

  const identity: AgentIdentityConfig = {
    name: pickString(value.name),
    description: pickString(value.description),
    instructions: pickString(value.instructions),
  };

  return Object.values(identity).some(Boolean) ? identity : undefined;
}

function parseAgentConfig(value: unknown): AgentConfig | undefined {
  if (!isPlainObject(value)) return undefined;

  const config: AgentConfig = {
    timeout: pickNumber(value.timeout),
    codexModel: pickString(value.codexModel),
    codexEffort: pickString(value.codexEffort),
    claudeModel: pickString(value.claudeModel),
    claudeEffort: pickString(value.claudeEffort),
    claudeThinking:
      value.claudeThinking === 'adaptive' ||
      value.claudeThinking === 'enabled' ||
      value.claudeThinking === 'disabled'
        ? value.claudeThinking
        : undefined,
    claudeThinkingBudget: pickNumber(value.claudeThinkingBudget),
    identity: parseIdentity(value.identity),
    promptInstructions: pickString(value.promptInstructions),
  };

  return Object.values(config).some((entry) => entry !== undefined)
    ? config
    : undefined;
}

function parseGlobalAgentConfig(value: unknown): GlobalAgentConfig | undefined {
  if (!isPlainObject(value)) return undefined;

  const roles = isPlainObject(value.roles)
    ? {
        owner: parseAgentConfig(value.roles.owner),
        reviewer: parseAgentConfig(value.roles.reviewer),
        arbiter: parseAgentConfig(value.roles.arbiter),
      }
    : undefined;

  const parsed: GlobalAgentConfig = {
    defaults: parseAgentConfig(value.defaults),
    roles:
      roles && Object.values(roles).some((entry) => entry !== undefined)
        ? roles
        : undefined,
  };

  return parsed.defaults || parsed.roles ? parsed : undefined;
}

export function getGlobalAgentConfigPath(groupsDir = GROUPS_DIR): string {
  return path.join(groupsDir, 'global', GLOBAL_AGENT_CONFIG_FILE);
}

export function readGlobalAgentConfig(
  groupsDir = GROUPS_DIR,
): GlobalAgentConfig | undefined {
  const filePath = getGlobalAgentConfigPath(groupsDir);
  if (!fs.existsSync(filePath)) return undefined;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return undefined;
    return parseGlobalAgentConfig(JSON.parse(raw));
  } catch (error) {
    logger.warn(
      { filePath, error },
      'Failed to read global agent configuration',
    );
    return undefined;
  }
}

function mergeIdentityConfigs(
  base?: AgentIdentityConfig,
  override?: AgentIdentityConfig,
): AgentIdentityConfig | undefined {
  const merged: AgentIdentityConfig = {
    name: override?.name ?? base?.name,
    description: override?.description ?? base?.description,
    instructions: override?.instructions ?? base?.instructions,
  };

  return Object.values(merged).some(Boolean) ? merged : undefined;
}

export function mergeAgentConfigs(
  ...configs: Array<AgentConfig | undefined>
): AgentConfig | undefined {
  let merged: AgentConfig | undefined;

  for (const config of configs) {
    if (!config) continue;
    merged = {
      timeout: config.timeout ?? merged?.timeout,
      codexModel: config.codexModel ?? merged?.codexModel,
      codexEffort: config.codexEffort ?? merged?.codexEffort,
      claudeModel: config.claudeModel ?? merged?.claudeModel,
      claudeEffort: config.claudeEffort ?? merged?.claudeEffort,
      claudeThinking: config.claudeThinking ?? merged?.claudeThinking,
      claudeThinkingBudget:
        config.claudeThinkingBudget ?? merged?.claudeThinkingBudget,
      promptInstructions:
        config.promptInstructions ?? merged?.promptInstructions,
      identity: mergeIdentityConfigs(merged?.identity, config.identity),
    };
  }

  return merged;
}

export function resolveAgentConfig(
  group: RegisteredGroup,
  role: PairedRoomRole = 'owner',
  globalConfig = readGlobalAgentConfig(),
): AgentConfig | undefined {
  return mergeAgentConfigs(
    globalConfig?.defaults,
    globalConfig?.roles?.[role],
    group.agentConfig,
  );
}

export function formatAgentIdentityPrompt(args: {
  role: PairedRoomRole;
  config?: AgentConfig;
}): string | undefined {
  const identity = args.config?.identity;
  const sections: string[] = [];

  if (identity?.name || identity?.description || identity?.instructions) {
    const lines = ['## Agent Identity', '', `Role: ${args.role}`];
    if (identity.name) lines.push(`Name: ${identity.name}`);
    if (identity.description)
      lines.push(`Description: ${identity.description}`);
    if (identity.instructions) {
      lines.push('', identity.instructions);
    }
    sections.push(lines.join('\n'));
  }

  if (args.config?.promptInstructions) {
    sections.push(
      `## Global Configuration\n\n${args.config.promptInstructions}`,
    );
  }

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}
