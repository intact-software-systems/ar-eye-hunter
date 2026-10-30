import { readALTargetGroupRef } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { GroupPublicationAuthority } from '../group-state/group-state-service-contracts.ts';
import { toMembersTopicPublicationAuthority } from './room-publication/compute-room-publication-admission.ts';
import type {
    RallarServerWsPublishAudienceInputDto,
    RallarServerWsPublishAudienceReader
} from './router/rallar-server-ws-router-contracts.ts';
import { computeServerRoomPublicationAudience } from './ws-topic-room-authorizer.ts';

export interface ServerPublishRoomAudienceDependencies {
    readonly readGroupSnapshot: (ref: GroupRef) => Promise<GroupSnapshot | undefined>;
    readonly readPublicationAuthority: (
        ref: GroupRef,
        topicId: string
    ) => Promise<GroupPublicationAuthority | undefined>;
    readonly nowEpochMs: () => number;
}

/**
 * The named room's audience for a server producer, read the way the room authorizer reads a sender's room (D58, Q7):
 * every live member session on a `members` topic, the subscribed ones on a `granted` topic that lists the producer
 * (D496, D489).
 */
export function createServerPublishRoomAudienceReader(
    dependencies: ServerPublishRoomAudienceDependencies
): RallarServerWsPublishAudienceReader {
    return async (input) => {
        const groupRef = readALTargetGroupRef(input.message);
        const authority = groupRef === undefined
            ? undefined
            : await readServerPublishAuthority(dependencies, groupRef, input);
        return computeServerRoomPublicationAudience({ ...input, authority, nowEpochMs: dependencies.nowEpochMs() });
    };
}

async function readServerPublishAuthority(
    dependencies: ServerPublishRoomAudienceDependencies,
    groupRef: GroupRef,
    input: RallarServerWsPublishAudienceInputDto
): Promise<GroupPublicationAuthority | undefined> {
    if (input.topic.participation === 'granted') {
        return await dependencies.readPublicationAuthority(groupRef, input.message.route.topicId);
    }
    const snapshot = await dependencies.readGroupSnapshot(groupRef);
    return snapshot === undefined ? undefined : toMembersTopicPublicationAuthority(snapshot);
}
