import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatAgentIdentityPrompt,
  mergeAgentConfigs,
  readGlobalAgentConfig,
  resolveAgentConfig,
} from './agent-config.js';
import type { RegisteredGroup } from '../shared/types.js';

describe('agent-config', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join('/tmp', 'goodkiddo-agent-config-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('merges defaults, role overrides, and group overrides in order', () => {
    const groupsDir = path.join(tempRoot, 'groups');
    fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, 'global', 'agent-config.json'),
      JSON.stringify({
        defaults: {
          timeout: 111,
          codexModel: 'gpt-default',
          identity: {
            name: 'Base',
            instructions: 'Start with steady progress.',
          },
        },
        roles: {
          reviewer: {
            timeout: 222,
            identity: {
              name: 'Reviewer',
              description: 'Checks the work before handoff.',
            },
          },
        },
      }),
    );

    const group: RegisteredGroup = {
      name: 'Room',
      folder: 'room',
      trigger: '@Codex',
      added_at: new Date().toISOString(),
      agentType: 'codex',
      agentConfig: {
        timeout: 333,
        codexModel: 'gpt-group',
        identity: {
          instructions: 'Be specific about risks.',
        },
      },
    };

    const globalConfig = readGlobalAgentConfig(groupsDir);
    const config = resolveAgentConfig(group, 'reviewer', globalConfig);

    expect(globalConfig?.defaults?.codexModel).toBe('gpt-default');
    expect(config).toEqual({
      timeout: 333,
      codexModel: 'gpt-group',
      identity: {
        name: 'Reviewer',
        description: 'Checks the work before handoff.',
        instructions: 'Be specific about risks.',
      },
    });
  });

  it('formats identity and prompt instructions into a prompt block', () => {
    const prompt = formatAgentIdentityPrompt({
      role: 'arbiter',
      config: mergeAgentConfigs(
        {
          identity: {
            name: 'Judge',
            description: 'Breaks deadlocks.',
          },
        },
        {
          promptInstructions: 'Prefer decisive verdicts with clear next steps.',
        },
      ),
    });

    expect(prompt).toBe(
      '## Agent Identity\n\nRole: arbiter\nName: Judge\nDescription: Breaks deadlocks.\n\n## Global Configuration\n\nPrefer decisive verdicts with clear next steps.',
    );
  });
});
