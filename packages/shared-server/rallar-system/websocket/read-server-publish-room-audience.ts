import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { RallarServerWsPublishAudienceReader } from './router/rallar-server-ws-router-contracts.ts';
import { computeServerRoomPublicationAudience } from './ws-topic-room-authorizer.ts';

export interface ServerPublishRoomAudienceDependencies {
    readonly readGroupSnapshot: (ref: GroupRef) => Promise<GroupSnapshot | undefined>;
    readonly nowEpochMs: () => number;
}

/**
 * The named room's audience for a server producer, read the way the room authorizer reads a sender's room (D58, Q7):
 * every live member session on a `members` topic, the subscribe-granted ones on a `granted` topic that lists the
 * producer (D496).
 */
export function createServerPublishRoomAudienceReader(
    dependencies: ServerPublishRoomAudienceDependencies
): RallarServerWsPublishAudienceReader {
    return async (input) => {
        const groupRef = readALTargetGroupRef(input.message);
        const snapshot = groupRef === undefined
            ? undefined
            : await dependencies.readGroupSnapshot(groupRef);
        return computeServerRoomPublicationAudience({ ...input, snapshot, nowEpochMs: dependencies.nowEpochMs() });
    };
}
