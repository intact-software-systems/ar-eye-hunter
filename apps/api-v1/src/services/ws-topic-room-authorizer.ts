import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/services/ws-topic-room-authorizer.ts';
import type { CachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';

export function createApiV1RoomWsAuthorizer(
  groupStateService: Pick<CachedGroupStateService, 'readCurrentSnapshot'>,
) {
  return createGroupRoomWsAuthorizer({
    findGroupSnapshotByRef: async (ref) =>
      await groupStateService.readCurrentSnapshot(ref),
  });
}
