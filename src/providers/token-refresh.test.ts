import { describe, expect, it } from 'vitest';

import {
  applyUpdatedTokensToEnvContent,
  shouldStartTokenRefreshLoop,
} from './token-refresh.js';

describe('shouldStartTokenRefreshLoop', () => {
  it('starts refresh for the Claude service', () => {
    expect(shouldStartTokenRefreshLoop('claude-code')).toBe(true);
  });

  it('skips refresh for the Codex service', () => {
    expect(shouldStartTokenRefreshLoop('codex')).toBe(false);
  });

  it('updates both multi-token and single-token env vars when present', () => {
    const next = applyUpdatedTokensToEnvContent(
      [
        'CLAUDE_CODE_OAUTH_TOKEN=old-primary',
        'CLAUDE_CODE_OAUTH_TOKENS=old-primary,old-secondary',
        'OTHER=value',
      ].join('\n'),
      ['new-primary', 'new-secondary'],
    );

    expect(next).toContain('CLAUDE_CODE_OAUTH_TOKEN=new-primary');
    expect(next).toContain(
      'CLAUDE_CODE_OAUTH_TOKENS=new-primary,new-secondary',
    );
  });

  it('adds the multi-token env var when it is missing', () => {
    const next = applyUpdatedTokensToEnvContent(
      ['CLAUDE_CODE_OAUTH_TOKEN=old-primary', 'OTHER=value'].join('\n'),
      ['new-primary', 'new-secondary'],
    );

    expect(next).toContain('CLAUDE_CODE_OAUTH_TOKEN=new-primary');
    expect(next).toContain(
      'CLAUDE_CODE_OAUTH_TOKENS=new-primary,new-secondary',
    );
  });
});
