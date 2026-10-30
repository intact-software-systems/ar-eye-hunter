import {
    resolveMemberPublicationPermissions,
    type GroupPublicationTopicPermissions
} from '@shared/api/group-publication/group-publication-grants.ts';

import type { RallarRoomTopicGrant, RallarRoomTopicRole } from '../rallar-room-contracts.ts';
import type { GroupSnapshot } from '../room-group-state-translation.ts';

export function toRoomTopicRole(permissions: GroupPublicationTopicPermissions): RallarRoomTopicRole {
    if (permissions.publish && permissions.subscribe) {
        return 'publisher-subscriber';
    }
    if (permissions.publish) {
        return 'publisher';
    }
    return permissions.subscribe ? 'subscriber' : 'none';
}

export function toRoomTopicGrants(
    snapshot: GroupSnapshot,
    principalId: string
): Readonly<Record<string, RallarRoomTopicGrant>> {
    const grant = snapshot.publicationGrants.find((candidate) => candidate.principalId === principalId);
    if (grant === undefined) {
        return {};
    }
    const member = snapshot.members.find((candidate) => candidate.principalId === principalId) ?? null;
    return Object.fromEntries(
        Object.keys(grant.topics).map((topicId) => {
            const permissions = resolveMemberPublicationPermissions(member, grant, topicId);
            return [topicId, { ...permissions, role: toRoomTopicRole(permissions) }];
        })
    );
}
