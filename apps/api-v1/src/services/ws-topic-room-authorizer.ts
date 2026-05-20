import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/services/ws-topic-room-authorizer.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
    createGroupStateSnapshotReadThroughCache
} from '@shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export function createApiV1RoomWsAuthorizer(
    groupsRepository?: Pick<GroupStateRepository, 'readSnapshot'>,
) {
    const readThroughCache = groupsRepository
        ? createGroupStateSnapshotReadThroughCache({ groupsRepository })
        : undefined;

    return createGroupRoomWsAuthorizer({
        findGroupSnapshotByRef: async (ref, input) =>
            readThroughCache
                ? await readThroughCache.findOrLoadByRef(ref, {
                    minSnapshotVersion: input.minSnapshotVersion,
                })
                : groupStateSnapshotsRepository.findGroupStateSnapshotByRef(ref),
        findGroupSnapshotById: groupStateSnapshotsRepository.findLatestGroupSnapshotById,
    });
}

export const authorizeApiV1RoomWsMessage = createApiV1RoomWsAuthorizer();
