import { describe, expect, it } from 'vitest';

import {
  createInitialAppServerTurnState,
  getAppServerTurnResult,
  reduceAppServerTurnState,
} from '../src/app-server-state.js';

describe('codex app-server turn state', () => {
  it('prefers final_answer over commentary when building final output', () => {
    let state = createInitialAppServerTurnState();

    state = reduceAppServerTurnState(state, {
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          phase: 'commentary',
          text: '중간 설명입니다.',
        },
      },
    });

    state = reduceAppServerTurnState(state, {
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          phase: 'final_answer',
          text: '최종 답변입니다.',
        },
      },
    });

    expect(getAppServerTurnResult(state)).toBe('최종 답변입니다.');
  });

  it('does not treat commentary-only messages as a final output', () => {
    const state = reduceAppServerTurnState(createInitialAppServerTurnState(), {
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          phase: 'commentary',
          text: '작업 중 상태입니다.',
        },
      },
    });

    expect(state.latestAgentMessage).toBe('작업 중 상태입니다.');
    expect(getAppServerTurnResult(state)).toBeNull();
  });

  it('records compaction completion from contextCompaction items', () => {
    const state = reduceAppServerTurnState(createInitialAppServerTurnState(), {
      method: 'item/completed',
      params: {
        item: {
          type: 'contextCompaction',
          id: 'ctx_1',
        },
      },
    });

    expect(state.compactionCompleted).toBe(true);
  });

  it('captures upstream HTTP status from app-server error events', () => {
    const state = reduceAppServerTurnState(createInitialAppServerTurnState(), {
      method: 'error',
      params: {
        error: {
          message: 'Too many requests',
          codexErrorInfo: {
            httpStatusCode: 429,
          },
        },
      },
    });

    expect(state.errorMessage).toBe('Too many requests (HTTP 429)');
  });
});
