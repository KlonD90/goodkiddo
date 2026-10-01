import {
  CODEX_MAIN_SERVICE_ID,
  CODEX_REVIEW_SERVICE_ID,
  normalizeServiceId,
} from '../config/config.js';
import type { PairedRoomRole, RoomRoleContext } from '../shared/types.js';
import type { EffectiveChannelLease } from '../paired/service-routing.js';

export function buildRoomRoleContext(
  lease: EffectiveChannelLease,
  serviceId: string,
  preferredRole?: PairedRoomRole,
): RoomRoleContext | undefined {
  const normalizedServiceId = normalizeServiceId(serviceId);
  const reviewerServiceId = lease.reviewer_service_id
    ? normalizeServiceId(lease.reviewer_service_id)
    : null;

  if (!reviewerServiceId) {
    return undefined;
  }

  const ownerServiceId = normalizeServiceId(lease.owner_service_id);
  const arbiterServiceId = lease.arbiter_service_id
    ? normalizeServiceId(lease.arbiter_service_id)
    : undefined;

  const matches = {
    owner: ownerServiceId === normalizedServiceId,
    reviewer: reviewerServiceId === normalizedServiceId,
    arbiter: arbiterServiceId === normalizedServiceId,
  };

  const role =
    preferredRole && matches[preferredRole]
      ? preferredRole
      : matches.arbiter
        ? 'arbiter'
        : matches.owner
          ? 'owner'
          : matches.reviewer
            ? 'reviewer'
            : null;

  if (!role) {
    return undefined;
  }

  return {
    serviceId: normalizedServiceId,
    role,
    ownerServiceId,
    reviewerServiceId,
    failoverOwner:
      ownerServiceId === CODEX_REVIEW_SERVICE_ID &&
      reviewerServiceId === CODEX_MAIN_SERVICE_ID,
    arbiterServiceId,
  };
}
