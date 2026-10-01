import { describe, expect, it } from 'vitest';

import { _testing } from './index.js';

describe('setup cli routing', () => {
  it('routes no-arg setup to the wizard', () => {
    expect(_testing.resolveSetupInvocation([])).toEqual({
      kind: 'wizard',
      wizardArgs: [],
    });
  });

  it('treats supported top-level flags as wizard prefill', () => {
    expect(
      _testing.resolveSetupInvocation(['--channel', 'discord', '--is-main']),
    ).toEqual({
      kind: 'wizard',
      wizardArgs: ['--channel', 'discord', '--is-main'],
    });
  });

  it('keeps explicit step dispatch for advanced flows', () => {
    expect(_testing.resolveSetupInvocation(['--step', 'verify'])).toEqual({
      kind: 'step',
      stepName: 'verify',
      stepArgs: [],
    });
  });

  it('supports uninstall as an explicit step', () => {
    expect(_testing.resolveSetupInvocation(['--step', 'uninstall'])).toEqual({
      kind: 'step',
      stepName: 'uninstall',
      stepArgs: [],
    });
  });

  it('rejects unknown top-level flags with a friendly error', () => {
    expect(_testing.resolveSetupInvocation(['--mystery'])).toEqual({
      kind: 'error',
      message: 'Unknown setup argument: --mystery',
      exitCode: 1,
    });
  });

  it('documents wizard-first usage in the help text', () => {
    const help = _testing.buildUsageText();

    expect(help).toContain('bun run setup');
    expect(help).toContain('Wizard prefill examples');
    expect(help).toContain('--step <');
    expect(help).toContain('uninstall');
  });
});
