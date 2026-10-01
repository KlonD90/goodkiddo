import { describe, expect, it } from 'vitest';

import {
  resolveAgentTypeForRole,
  resolveRoleAgentPlan,
} from './role-agent-plan.js';

describe('resolveRoleAgentPlan', () => {
  it('uses the group agent type as owner in single rooms', () => {
    expect(
      resolveRoleAgentPlan({
        paired: false,
        groupAgentType: 'codex',
        configuredReviewer: 'claude-code',
        configuredArbiter: 'claude-code',
      }),
    ).toEqual({
      ownerAgentType: 'codex',
      reviewerAgentType: null,
      arbiterAgentType: null,
    });
  });

  it('falls back to claude-code when group agent type is undefined', () => {
    expect(
      resolveRoleAgentPlan({
        paired: false,
        groupAgentType: undefined,
        configuredReviewer: 'codex',
      }),
    ).toEqual({
      ownerAgentType: 'claude-code',
      reviewerAgentType: null,
      arbiterAgentType: null,
    });
  });

  it('uses configured reviewer and arbiter when paired room roles differ', () => {
    expect(
      resolveRoleAgentPlan({
        paired: true,
        groupAgentType: 'codex',
        configuredReviewer: 'claude-code',
        configuredArbiter: 'claude-code',
      }),
    ).toEqual({
      ownerAgentType: 'codex',
      reviewerAgentType: 'claude-code',
      arbiterAgentType: 'claude-code',
    });
  });

  it('collapses reviewer to owner and keeps arbiter null when absent', () => {
    expect(
      resolveRoleAgentPlan({
        paired: true,
        groupAgentType: 'claude-code',
        configuredReviewer: 'claude-code',
      }),
    ).toEqual({
      ownerAgentType: 'claude-code',
      reviewerAgentType: 'claude-code',
      arbiterAgentType: null,
    });
  });

  it('falls back to owner when reviewer or arbiter are absent in the plan', () => {
    const plan = resolveRoleAgentPlan({
      paired: false,
      groupAgentType: 'codex',
      configuredReviewer: 'claude-code',
    });

    expect(resolveAgentTypeForRole(plan, 'owner')).toBe('codex');
    expect(resolveAgentTypeForRole(plan, 'reviewer')).toBe('codex');
    expect(resolveAgentTypeForRole(plan, 'arbiter')).toBe('codex');
  });

  it('returns explicit reviewer and arbiter agent types when present', () => {
    const plan = resolveRoleAgentPlan({
      paired: true,
      groupAgentType: 'codex',
      configuredReviewer: 'claude-code',
      configuredArbiter: 'claude-code',
    });

    expect(resolveAgentTypeForRole(plan, 'reviewer')).toBe('claude-code');
    expect(resolveAgentTypeForRole(plan, 'arbiter')).toBe('claude-code');
  });
});
