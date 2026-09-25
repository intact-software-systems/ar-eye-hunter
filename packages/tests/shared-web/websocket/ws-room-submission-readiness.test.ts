import {
    describe,
    expect,
    it
} from 'vitest';

import {
    computeBrowserWsRoomSubmissionIneligibility,
    requiresBrowserWsRoomPresence,
    type BrowserWsRoomSubmissionInput
} from '@shared-web/browser/websocket/compute-browser-ws-room-submission-ineligibility.ts';
import { newALBroadcastMessage, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_REPAIR_TYPE_ID
} from '@shared/al-contracts/al-control-type-ids.ts';
import { AppTopics, type AuthSession } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RALLAR_AL_CONTROL_TOPIC_ID } from '@shared/api/rallar-validation.ts';
import { RALLAR_CRDT_ROOM_TOPIC_ID } from '@shared/crdt/crdt-types.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

interface ReadyRoomSubmission extends BrowserWsRoomSubmissionInput {
    readonly currentSession: AuthSession;
    readonly snapshot: GroupSnapshot;
}

function createReadyRoomSubmission(): ReadyRoomSubmission {
    return {
        message: newALBroadcastMessage('alice', { topicId: 'room.chat', contextId: 'room', resourceId: 'original' }, 'room', 'chat.message', {}, {
            groupRef: roomRef
        }),
        client: { clientId: 'alice', sessionId: 'alice', isOnline: true },
        currentSession: { clientId: 'alice', sessionId: 'alice', accessToken: 'test-only', username: 'alice', expiresAtEpochMs: 60_000 },
        snapshot: createGroupSnapshotFixture({ ...roomRef, sessionIds: ['alice'] }),
        nowMs: 1_000
    };
}

interface SnapshotCase {
    readonly name: string;
    readonly change: (snapshot: GroupSnapshot) => GroupSnapshot;
}

const invalidObservations: readonly SnapshotCase[] = [
    { name: 'same room id in another scope', change: (s) => ({ ...s, group: { ...s.group, workspaceId: 'other' } }) },
    { name: 'archived group', change: (s) => ({ ...s, group: { ...s.group, status: 'archived', archived: s.group.updated, deleted: null } }) },
    { name: 'expired group', change: (s) => ({ ...s, group: { ...s.group, expiresAtEpochMs: 1_000 } }) },
    { name: 'missing sender session', change: (s) => ({ ...s, activeSessions: [] }) },
    { name: 'another session for the same principal', change: (s) => ({ ...s, activeSessions: s.activeSessions.map((v) => ({ ...v, sessionId: 'other' })) }) },
    {
        name: 'another principal for the sender session',
        change: (s) => ({ ...s, activeSessions: s.activeSessions.map((v) => ({ ...v, principalId: 'other' })) })
    },
    { name: 'wrong session scope', change: (s) => ({ ...s, activeSessions: s.activeSessions.map((v) => ({ ...v, workspaceId: 'other' })) }) },
    { name: 'expired sender presence', change: (s) => ({ ...s, activeSessions: s.activeSessions.map((v) => ({ ...v, expiresAtEpochMs: 1_000 })) }) },
    {
        name: 'disconnected sender presence',
        change: (s) => ({
            ...s,
            activeSessions: s.activeSessions.map((v) => ({ ...v, status: 'disconnected', disconnectedAtEpochMs: 999, disconnectReason: 'left' }))
        })
    },
    { name: 'missing member', change: (s) => ({ ...s, members: [] }) },
    {
        name: 'removed member',
        change: (s) => ({ ...s, members: s.members.map((v) => ({ ...v, status: 'removed', left: null, removed: v.updated, banned: null })) })
    },
    {
        name: 'banned member',
        change: (s) => ({ ...s, members: s.members.map((v) => ({ ...v, status: 'banned', left: null, removed: null, banned: v.updated })) })
    },
    { name: 'wrong member scope', change: (s) => ({ ...s, members: s.members.map((v) => ({ ...v, applicationId: 'other' })) }) }
];

interface OriginalCase {
    readonly name: string;
    readonly change: (input: ReadyRoomSubmission) => BrowserWsRoomSubmissionInput;
}

const invalidOriginals: readonly OriginalCase[] = [
    { name: 'missing snapshot', change: (input) => ({ ...input, snapshot: undefined }) },
    { name: 'missing auth', change: (input) => ({ ...input, currentSession: undefined }) },
    { name: 'changed session', change: (input) => ({ ...input, currentSession: { ...input.currentSession, sessionId: 'next' } }) },
    { name: 'changed principal', change: (input) => ({ ...input, currentSession: { ...input.currentSession, clientId: 'next' } }) },
    { name: 'wrong original sender', change: (input) => ({ ...input, message: { ...input.message, id: { ...input.message.id, senderId: 'other' } } }) },
    { name: 'missing scoped target', change: (input) => ({ ...input, message: { ...input.message, targets: { mode: 'broadcast', scope: 'room' } } }) }
];

describe('browser room submission prerequisite', () => {
    it('permits current presence without requiring an active formation lifecycle', () => {
        const input = createReadyRoomSubmission();
        expect(computeBrowserWsRoomSubmissionIneligibility(input)).toBeUndefined();
        expect(computeBrowserWsRoomSubmissionIneligibility({
            ...input,
            snapshot: { ...input.snapshot, group: { ...input.snapshot.group, lifecycleState: 'forming' } }
        })).toBeUndefined();
    });

    it.each(invalidObservations)('withholds $name', ({ change }) => {
        const input = createReadyRoomSubmission();
        expect(computeBrowserWsRoomSubmissionIneligibility({ ...input, snapshot: change(input.snapshot) })).toEqual(expect.any(String));
    });

    it.each(invalidOriginals)('withholds $name', ({ change }) => {
        expect(computeBrowserWsRoomSubmissionIneligibility(change(createReadyRoomSubmission()))).toEqual(expect.any(String));
    });

    it.each([...Object.values(AppTopics), RALLAR_AL_CONTROL_TOPIC_ID])('keeps exact %s bootstrap independent even with room targets', (topicId) => {
        const message = createReadyRoomSubmission().message;
        expect(requiresBrowserWsRoomPresence({ ...message, route: { ...message.route, topicId } })).toBe(false);
    });

    it.each([AL_CONTROL_ACK_TYPE_ID, AL_CONTROL_NACK_TYPE_ID, AL_CONTROL_REPAIR_TYPE_ID])('keeps room-shaped %s control independent', (typeId) => {
        const message = createReadyRoomSubmission().message;
        expect(requiresBrowserWsRoomPresence({ ...message, payload: { ...message.payload, typeId } })).toBe(false);
    });

    it('requires presence for CRDT and unknown reserved-prefix room application messages', () => {
        const message = createReadyRoomSubmission().message;
        for (const topicId of [RALLAR_CRDT_ROOM_TOPIC_ID, 'rallar.unknown']) {
            expect(requiresBrowserWsRoomPresence({ ...message, route: { ...message.route, topicId } })).toBe(true);
        }
    });

    it('leaves ordinary unicast eligibility with its transport owner', () => {
        expect(
            requiresBrowserWsRoomPresence(
                newALUnicastMessage('alice', { topicId: 'app.chat', contextId: 'conversation', resourceId: 'one' }, 'bob', 'chat', {})
            )
        ).toBe(false);
    });
});
