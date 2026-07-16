import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/services/ws-topic-room-authorizer.ts';
import type { GroupStateService } from '@shared-server/rallar-system/services/group-state-service.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export function createApiV1RoomWsAuthorizer(
  groupStateService?: Pick<GroupStateService, 'readSnapshot'>,
) {
  return createGroupRoomWsAuthorizer({
    findGroupSnapshotByRef: async (ref, input) =>
      groupStateService
        ? await groupStateService.readSnapshot(ref).then((snapshot) => {
          if (
            snapshot &&
            input.minSnapshotVersion !== undefined &&
            snapshot.group.snapshotVersion < input.minSnapshotVersion
          ) {
            return undefined;
          }
          return snapshot;
        })
        : groupStateSnapshotsRepository.findGroupStateSnapshotByRef(ref),
    findGroupSnapshotById: groupStateSnapshotsRepository.findLatestGroupSnapshotById,
  });
}

export const authorizeApiV1RoomWsMessage = createApiV1RoomWsAuthorizer();
