import { describe, expect, it } from 'vitest';

import { prependRoomRoleHeader } from '../src/room-role-context.js';

describe('claude runner room role header', () => {
  it('prepends a canonical role header when metadata exists', () => {
    expect(
      prependRoomRoleHeader('hello', {
        serviceId: 'codex-review',
        role: 'owner',
        ownerServiceId: 'codex-review',
        reviewerServiceId: 'codex-main',
        failoverOwner: true,
      }),
    ).toBe(
      '[ROOM_ROLE self=codex-review role=owner owner=codex-review reviewer=codex-main failover=1]\n\nhello',
    );
  });

  it('leaves prompts unchanged without room metadata', () => {
    expect(prependRoomRoleHeader('hello')).toBe('hello');
  });
});
