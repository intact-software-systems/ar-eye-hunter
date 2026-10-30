import { describe, expect, it } from 'vitest';

import { toRoomTopicGrants, toRoomTopicRole } from '@shared-web/browser/rooms/topic-grants/room-topic-roles.ts';
import type { GroupPublicationTopicGrants } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';

import { createAuditStampFixture, createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';

const ROOM_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };

describe('room topic roles', () => {
    it('toRoomTopicRole maps the four permission pairs', () => {
        expect([
            toRoomTopicRole({ publish: true, subscribe: true }),
            toRoomTopicRole({ publish: true, subscribe: false }),
            toRoomTopicRole({ publish: false, subscribe: true }),
            toRoomTopicRole({ publish: false, subscribe: false })
        ]).toEqual(['publisher-subscriber', 'publisher', 'subscriber', 'none']);
    });

    it('toRoomTopicGrants is effective: a spectator\'s publish row reads subscriber, a left member reads none', () => {
        const topics: GroupPublicationTopicGrants = {
            'room.feed': { publish: true, subscribe: true },
            'room.score': { publish: true, subscribe: false }
        };
        const snapshot = withGrants(createSnapshot(['spectator-1', 'left-1', 'member-1']), {
            'spectator-1': topics,
            'left-1': topics,
            'member-1': topics
        });
        const members = snapshot.members.map((member): GroupMember =>
            member.principalId === 'spectator-1'
                ? { ...member, role: 'spectator' }
                : member.principalId === 'left-1'
                ? {
                    ...member,
                    status: 'left',
                    joined: createAuditStampFixture(1, 'creator'),
                    left: createAuditStampFixture(2, 'left-1'),
                    removed: null,
                    banned: null
                }
                : member
        );
        const effective = { ...snapshot, members };

        expect({
            spectator: toRoomTopicGrants(effective, 'spectator-1'),
            left: toRoomTopicGrants(effective, 'left-1'),
            member: toRoomTopicGrants(effective, 'member-1'),
            ungranted: toRoomTopicGrants(createSnapshot(['member-2']), 'member-2')
        }).toEqual({
            spectator: {
                'room.feed': { publish: false, subscribe: true, role: 'subscriber' },
                'room.score': { publish: false, subscribe: false, role: 'none' }
            },
            left: {
                'room.feed': { publish: false, subscribe: false, role: 'none' },
                'room.score': { publish: false, subscribe: false, role: 'none' }
            },
            member: {
                'room.feed': { publish: true, subscribe: true, role: 'publisher-subscriber' },
                'room.score': { publish: true, subscribe: false, role: 'publisher' }
            },
            ungranted: {}
        });
    });
});

function createSnapshot(principalIds: readonly string[]): GroupSnapshot {
    return createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: principalIds });
}

function withGrants(
    snapshot: GroupSnapshot,
    topicsByPrincipalId: Readonly<Record<string, GroupPublicationTopicGrants>>
): GroupSnapshot {
    return {
        ...snapshot,
        publicationGrants: Object.entries(topicsByPrincipalId).map(([principalId, topics]) => ({
            ...ROOM_REF,
            principalId,
            topics,
            updated: createAuditStampFixture(1, 'creator')
        }))
    };
}
