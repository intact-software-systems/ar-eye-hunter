import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/services/ws-topic-room-authorizer.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export const authorizeApiV1RoomWsMessage = createGroupRoomWsAuthorizer({
    findGroupSnapshotByRef: (ref) =>
        groupStateSnapshotsRepository.findGroupStateSnapshotByRef(ref),
    findGroupSnapshotById: groupStateSnapshotsRepository.findLatestGroupSnapshotById,
});
