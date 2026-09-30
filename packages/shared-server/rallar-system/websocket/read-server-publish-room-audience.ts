import { readALTargetGroupRef, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { RallarServerWsPublishAudienceReader } from './router/rallar-server-ws-router-contracts.ts';
import { computeServerRoomPublicationAudience } from './ws-topic-room-authorizer.ts';

export interface ServerPublishRoomAudienceDependencies {
    readonly readGroupSnapshot: (ref: GroupRef) => Promise<GroupSnapshot | undefined>;
    readonly nowEpochMs: () => number;
}

/** The named room's active members' live sessions, read the way the room authorizer reads a sender's room (D58, Q7). */
export function createServerPublishRoomAudienceReader(
    dependencies: ServerPublishRoomAudienceDependencies
): RallarServerWsPublishAudienceReader {
    return async (message: ALMessage) => {
        const groupRef = readALTargetGroupRef(message);
        const snapshot = groupRef === undefined
            ? undefined
            : await dependencies.readGroupSnapshot(groupRef);
        return computeServerRoomPublicationAudience(snapshot, message, dependencies.nowEpochMs());
    };
}
