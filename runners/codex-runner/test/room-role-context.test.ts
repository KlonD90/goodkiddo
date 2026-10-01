import { describe, expect, it } from 'vitest';

import { prependRoomRoleHeader } from '../src/room-role-context.js';

describe('codex runner room role header', () => {
  it('prepends a canonical role header when metadata exists', () => {
    expect(
      prependRoomRoleHeader('hello', {
        serviceId: 'codex-main',
        role: 'reviewer',
        ownerServiceId: 'claude',
        reviewerServiceId: 'codex-main',
        failoverOwner: false,
      }),
    ).toBe(
      '[ROOM_ROLE self=codex-main role=reviewer owner=claude reviewer=codex-main failover=0]\n\nhello',
    );
  });

  it('leaves prompts unchanged without room metadata', () => {
    expect(prependRoomRoleHeader('hello')).toBe('hello');
  });
});
