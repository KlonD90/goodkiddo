import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_LANGUAGE } from '../config/config.js';
import {
  getPairedRoomPromptPath,
  getPlatformPromptPath,
  readPairedRoomPrompt,
  readPlatformPrompt,
} from './platform-prompts.js';

describe('platform-prompts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goodkiddo-prompts-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when the prompt file is missing', () => {
    expect(readPlatformPrompt('claude-code')).toBeUndefined();
  });

  it('reads and trims provider-specific prompt files', () => {
    const promptsDir = path.join(tempDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'codex-platform.md'),
      '\nCodex platform prompt\n',
    );

    expect(getPlatformPromptPath('codex')).toBe(
      path.join(promptsDir, 'codex-platform.md'),
    );
    expect(readPlatformPrompt('codex')).toBe('Codex platform prompt');
  });

  it('reads and trims paired-room prompt files', () => {
    const promptsDir = path.join(tempDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'claude-paired-room.md'),
      '\nClaude paired prompt\n',
    );

    expect(getPairedRoomPromptPath('claude-code')).toBe(
      path.join(promptsDir, 'claude-paired-room.md'),
    );
    const expected = AGENT_LANGUAGE
      ? `Claude paired prompt\n\n## Language\n\nAlways respond in ${AGENT_LANGUAGE}.`
      : 'Claude paired prompt';
    expect(readPairedRoomPrompt('claude-code')).toBe(expected);
  });

  it('maps Codex paired-room prompts to the shared reviewer prompt while preserving failover identity wording', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const expectedPromptPath = path.join(
      path.dirname(repoRoot),
      'prompts',
      'claude-paired-room.md',
    );

    expect(getPairedRoomPromptPath('codex', repoRoot)).toBe(expectedPromptPath);

    const codexPairedPrompt = readPairedRoomPrompt('codex', repoRoot);
    expect(codexPairedPrompt).toContain('reviewer');
    expect(codexPairedPrompt).not.toContain('owner-side paired agent');

    const failoverPlatformPrompt = fs.readFileSync(
      path.join(
        path.dirname(repoRoot),
        'prompts',
        'codex-review-failover-platform.md',
      ),
      'utf-8',
    );
    expect(failoverPlatformPrompt).toContain('acting as `클코`');
  });
});
