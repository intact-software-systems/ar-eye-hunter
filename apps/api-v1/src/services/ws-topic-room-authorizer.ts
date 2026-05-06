import type { RallarServerWsRoomAuthorizer } from '@shared-server/rallar-facade/ws-topic-router.ts';
import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export const authorizeApiV1RoomWsMessage: RallarServerWsRoomAuthorizer = (
    input,
) => {
    const snapshot = groupStateSnapshotsRepository.findGroupStateSnapshotById(
        input.roomId,
    );

    return !!snapshot &&
        isGroupActive(snapshot) &&
        isSessionInGroup(snapshot, input.senderId);
};
