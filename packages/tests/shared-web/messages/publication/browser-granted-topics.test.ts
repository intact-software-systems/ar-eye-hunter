import { BrowserGrantedTopics } from '@shared-web/browser/messages/publication/browser-granted-topics.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { describe, expect, it, vi } from 'vitest';
import { createAuditStampFixture, createGroupSnapshotFixture } from '../../authoritative-group-fixtures.ts';

const ROOM_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const OTHER_ROOM_REF = { ...ROOM_REF, groupId: 'room-2' };

describe('BrowserGrantedTopics', () => {
    it('names a topic a typed channel declared granted in every room', () => {
        const topics = new BrowserGrantedTopics({ findGroupSnapshot: () => undefined });

        topics.declareGrantedTopic('room.feed');

        expect(topics.isGrantedTopic(ROOM_REF, 'room.feed')).toBe(true);
        expect(topics.isGrantedTopic(OTHER_ROOM_REF, 'room.feed')).toBe(true);
        expect(topics.isGrantedTopic(ROOM_REF, 'room.chat')).toBe(false);
    });

    it('names a topic the room\'s cached snapshot grants, in that room only', () => {
        const snapshot = createGrantingSnapshot('room.scores');
        const topics = new BrowserGrantedTopics({
            findGroupSnapshot: (roomRef) => roomRef.groupId === ROOM_REF.groupId ? snapshot : undefined
        });

        expect(topics.isGrantedTopic(ROOM_REF, 'room.scores')).toBe(true);
        expect(topics.isGrantedTopic(OTHER_ROOM_REF, 'room.scores')).toBe(false);
        expect(topics.isGrantedTopic(ROOM_REF, 'room.chat')).toBe(false);
    });

    it('names a declared topic for a frame naming no room, and no other topic, without reading any snapshot', () => {
        const findGroupSnapshot = vi.fn(() => createGrantingSnapshot('room.scores'));
        const topics = new BrowserGrantedTopics({ findGroupSnapshot });

        topics.declareGrantedTopic('app.feed');

        expect(topics.isGrantedTopic(undefined, 'app.feed')).toBe(true);
        expect(topics.isGrantedTopic(undefined, 'room.scores')).toBe(false);
        expect(findGroupSnapshot).not.toHaveBeenCalled();
    });
});

function createGrantingSnapshot(topicId: string): GroupSnapshot {
    return {
        ...createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: ['bob'] }),
        publicationGrants: [{
            ...ROOM_REF,
            principalId: 'bob',
            topics: { [topicId]: { publish: false, subscribe: true } },
            updated: createAuditStampFixture(2, 'creator')
        }]
    };
}
