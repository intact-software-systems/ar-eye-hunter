import {
    resolveMemberPublicationPermissions,
    type GroupPublicationGrant,
    type GroupPublicationTopicPermissions
} from '@shared/api/group-publication/group-publication-grants.ts';

import type { RallarRoomTopicGrant, RallarRoomTopicRole } from '../rallar-room-contracts.ts';
import type { GroupMember } from '../room-group-state-translation.ts';

export function toRoomTopicRole(permissions: GroupPublicationTopicPermissions): RallarRoomTopicRole {
    if (permissions.publish && permissions.subscribe) {
        return 'publisher-subscriber';
    }
    if (permissions.publish) {
        return 'publisher';
    }
    return permissions.subscribe ? 'subscriber' : 'none';
}

/** The member's effective permission on each topic of its own grant row; `{}` without a row. */
export function toRoomTopicGrants(
    member: GroupMember,
    grant: GroupPublicationGrant | undefined
): Readonly<Record<string, RallarRoomTopicGrant>> {
    if (grant === undefined) {
        return {};
    }
    return Object.fromEntries(
        Object.keys(grant.topics).map((topicId) => {
            const permissions = resolveMemberPublicationPermissions(member, grant, topicId);
            return [topicId, { ...permissions, role: toRoomTopicRole(permissions) }];
        })
    );
}
