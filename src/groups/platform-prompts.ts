import fs from 'fs';
import path from 'path';

import { AGENT_LANGUAGE } from '../config/config.js';
import type { AgentType } from '../shared/types.js';

function appendLanguageInstruction(prompt: string): string {
  if (!AGENT_LANGUAGE) return prompt;
  return `${prompt}\n\n## Language\n\nAlways respond in ${AGENT_LANGUAGE}.`;
}

const PLATFORM_PROMPT_FILES: Record<AgentType, string> = {
  'claude-code': 'claude-platform.md',
  codex: 'codex-platform.md',
};

// SSOT: both agent types use the same paired room prompts.
// Role-specific rules (owner vs reviewer) are selected by the caller.
const PAIRED_ROOM_PROMPT_FILES: Record<AgentType, string> = {
  'claude-code': 'claude-paired-room.md',
  codex: 'claude-paired-room.md',
};

const ARBITER_PROMPT_FILE = 'arbiter-paired-room.md';

export function getPlatformPromptsDir(projectRoot = process.cwd()): string {
  const localPromptsDir = path.join(projectRoot, 'prompts');
  if (fs.existsSync(localPromptsDir)) {
    return localPromptsDir;
  }

  // Some tests and tools pass the src/ directory as the root after the repo
  // reorganization. Fall back to the parent repo prompts dir when present.
  const parentPromptsDir = path.join(projectRoot, '..', 'prompts');
  if (fs.existsSync(parentPromptsDir)) {
    return parentPromptsDir;
  }

  return localPromptsDir;
}

export function getPlatformPromptPath(
  agentType: AgentType,
  projectRoot = process.cwd(),
): string {
  return path.join(
    getPlatformPromptsDir(projectRoot),
    PLATFORM_PROMPT_FILES[agentType],
  );
}

export function readPlatformPrompt(
  agentType: AgentType,
  projectRoot = process.cwd(),
): string | undefined {
  const promptPath = getPlatformPromptPath(agentType, projectRoot);
  if (!fs.existsSync(promptPath)) return undefined;

  const prompt = fs.readFileSync(promptPath, 'utf-8').trim();
  return prompt || undefined;
}

export function getPairedRoomPromptPath(
  agentType: AgentType,
  projectRoot = process.cwd(),
): string {
  return path.join(
    getPlatformPromptsDir(projectRoot),
    PAIRED_ROOM_PROMPT_FILES[agentType],
  );
}

export function readPairedRoomPrompt(
  agentType: AgentType,
  projectRoot = process.cwd(),
): string | undefined {
  const promptPath = getPairedRoomPromptPath(agentType, projectRoot);
  if (!fs.existsSync(promptPath)) return undefined;

  const prompt = fs.readFileSync(promptPath, 'utf-8').trim();
  return prompt ? appendLanguageInstruction(prompt) : undefined;
}

export function getArbiterPromptPath(projectRoot = process.cwd()): string {
  return path.join(getPlatformPromptsDir(projectRoot), ARBITER_PROMPT_FILE);
}

export function readArbiterPrompt(
  projectRoot = process.cwd(),
): string | undefined {
  const promptPath = getArbiterPromptPath(projectRoot);
  if (!fs.existsSync(promptPath)) return undefined;

  const prompt = fs.readFileSync(promptPath, 'utf-8').trim();
  return prompt ? appendLanguageInstruction(prompt) : undefined;
}
