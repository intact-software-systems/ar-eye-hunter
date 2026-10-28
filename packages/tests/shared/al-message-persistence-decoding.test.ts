import { AL_MESSAGE_ENVELOPE_VERSION } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALMessageValue,
    decodePersistedALMessage,
    decodePersistedALMessageValue
} from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

interface MutablePersistedALMessageFixture {
    id: {
        v: number;
        msgId: string;
        ts: number;
        senderId: string;
        traceId: string;
    };
    route: {
        topicId: string;
        resourceId: string;
        contextId: string;
    };
    targets: {
        mode: string;
        scope: string;
        groupRef?: {
            applicationId: string;
            workspaceId: string;
            groupId: string;
        };
        recipientPeerIds?: string[];
    };
    payload: {
        typeId: string;
        resource: string;
    };
}

describe('persisted AL message decoding', () => {
    it.each([
        {
            mode: 'multicast',
            targets: {
                mode: 'multicast',
                groupRef: { applicationId: 'app-1', groupId: 'room-1' }
            }
        },
        {
            mode: 'broadcast',
            targets: {
                mode: 'broadcast',
                scope: 'room',
                groupRef: { applicationId: 'app-1', groupId: 'room-1' }
            }
        }
    ])('rejects a $mode target whose group ref omits workspaceId', ({ targets }) => {
        expect(() =>
            decodePersistedALMessageValue({
                id: {
                    v: 4,
                    msgId: 'message-1',
                    ts: 1,
                    senderId: 'server-1',
                    traceId: 'trace-al-message-persistence-decoding'
                },
                route: {
                    topicId: 'topic-1',
                    resourceId: 'resource-1',
                    contextId: 'context-1'
                },
                targets,
                payload: {
                    typeId: 'type-1',
                    resource: '{}'
                }
            })
        ).toThrow(/workspace/);
    });

    it('rejects a room broadcast without a group ref', () => {
        expect(() =>
            decodePersistedALMessageValue({
                id: {
                    v: 4,
                    msgId: 'message-1',
                    ts: 1,
                    senderId: 'server-1',
                    traceId: 'trace-al-message-persistence-decoding'
                },
                route: {
                    topicId: 'topic-1',
                    resourceId: 'resource-1',
                    contextId: 'context-1'
                },
                targets: {
                    mode: 'broadcast',
                    scope: 'room'
                },
                payload: {
                    typeId: 'type-1',
                    resource: '{}'
                }
            })
        ).toThrow(/room.*group ref|group ref.*room/i);
    });

    it('accepts a canonical fixed recipient audience for a room broadcast', () => {
        expect(() =>
            decodePersistedALMessageValue({
                id: {
                    v: 4,
                    msgId: 'message-1',
                    ts: 1,
                    senderId: 'server-1',
                    traceId: 'trace-al-message-persistence-decoding'
                },
                route: {
                    topicId: 'overlay.topology',
                    resourceId: 'resource-1',
                    contextId: 'room-1'
                },
                targets: {
                    mode: 'broadcast',
                    scope: 'room',
                    groupRef: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        groupId: 'room-1'
                    },
                    minSnapshotVersion: 3,
                    recipientPeerIds: ['session-a', 'session-b']
                },
                payload: {
                    typeId: 'overlay.topology',
                    resource: '{}'
                }
            })
        ).not.toThrow();
    });

    it.each([
        { label: 'an unfrozen multicast', audience: {}, accepted: true },
        { label: 'a frozen multicast', audience: { recipientPeerIds: ['session-a'], snapshotVersion: 1 }, accepted: true },
        { label: 'a frozen multicast with an empty audience', audience: { recipientPeerIds: [], snapshotVersion: 4 }, accepted: true },
        { label: 'recipients without their snapshot version', audience: { recipientPeerIds: ['session-a'] }, accepted: false },
        { label: 'a snapshot version without its recipients', audience: { snapshotVersion: 4 }, accepted: false },
        { label: 'a snapshot version below one', audience: { recipientPeerIds: ['session-a'], snapshotVersion: 0 }, accepted: false },
        { label: 'a repeated recipient', audience: { recipientPeerIds: ['session-a', 'session-a'], snapshotVersion: 4 }, accepted: false }
    ])('decodes $label only when the frozen audience pair is whole', ({ audience, accepted }) => {
        const decoded = decodeALMessageValue({
            id: { v: 4, msgId: 'message-1', ts: 1, senderId: 'session-origin', traceId: 'trace-al-message-persistence-decoding' },
            route: { topicId: 'topic-1', resourceId: 'resource-1', contextId: 'room-1' },
            targets: {
                mode: 'multicast',
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
                ...audience
            },
            payload: { typeId: 'type-1', resource: '{}' }
        });

        expect(decoded.left === undefined).toBe(accepted);
    });

    it.each([
        { label: 'a multicast stamped with its roster', targets: { mode: 'multicast', rosterVersion: 4 }, accepted: true },
        { label: 'a multicast roster below one', targets: { mode: 'multicast', rosterVersion: 0 }, accepted: false },
        { label: 'a multicast membership epoch', targets: { mode: 'multicast', membershipEpoch: 1 }, accepted: false },
        {
            label: 'a room broadcast stamped with its roster',
            targets: { mode: 'broadcast', scope: 'room', minSnapshotVersion: 7, rosterVersion: 4 },
            accepted: true
        },
        {
            label: 'a room broadcast roster below one',
            targets: { mode: 'broadcast', scope: 'room', rosterVersion: 0 },
            accepted: false
        }
    ])('decodes $label only when the roster field is a version', ({ targets, accepted }) => {
        const decoded = decodeALMessageValue({
            id: { v: 4, msgId: 'message-1', ts: 1, senderId: 'session-origin', traceId: 'trace-al-message-persistence-decoding' },
            route: { topicId: 'topic-1', resourceId: 'resource-1', contextId: 'room-1' },
            targets: {
                groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
                ...targets
            },
            payload: { typeId: 'type-1', resource: '{}' }
        });

        expect(decoded.left === undefined).toBe(accepted);
    });

    it('stamps the current envelope version and refuses any other as unsupported', () => {
        const current = currentPersistedALMessage();

        expect(AL_MESSAGE_ENVELOPE_VERSION).toBe(4);
        expect(decodeALMessageValue(current).left).toBeUndefined();
        for (const v of [3, 5]) {
            expect(decodeALMessageValue({ ...current, id: { ...current.id, v } }).left).toEqual({
                code: 'unsupported',
                message: 'AL envelope version is unsupported'
            });
        }
    });

    it('keeps the trace of a persisted envelope through a round trip', () => {
        const current = currentPersistedALMessage();

        expect(decodePersistedALMessage(JSON.stringify(current)).id.traceId).toBe('trace-persistence-decoding');
    });

    it('refuses an envelope without a trace as malformed', () => {
        const { traceId: _traceId, ...untraced } = currentPersistedALMessage().id;

        expect(decodeALMessageValue({ ...currentPersistedALMessage(), id: untraced }).left?.code).toBe('malformed');
    });

    it.each(['', 'a'.repeat(129), 'trace 01', 'trace:01', 7])('refuses the malformed trace %j as malformed', (traceId) => {
        const current = currentPersistedALMessage();

        expect(decodeALMessageValue({ ...current, id: { ...current.id, traceId } }).left?.code).toBe('malformed');
    });

    it('accepts the current principal broadcast target shape', () => {
        expect(() =>
            decodePersistedALMessageValue({
                id: {
                    v: 4,
                    msgId: 'message-1',
                    ts: 1,
                    senderId: 'server-1',
                    traceId: 'trace-al-message-persistence-decoding'
                },
                route: {
                    topicId: 'state-sync',
                    resourceId: 'resource-1',
                    contextId: 'principal-1'
                },
                targets: {
                    mode: 'broadcast',
                    scope: 'principal',
                    principalRef: {
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        principalId: 'principal-1'
                    }
                },
                payload: {
                    typeId: 'state-sync',
                    resource: '{}'
                }
            })
        ).not.toThrow();
    });

    it('decodes a serialized current envelope and rejects malformed stored shapes', () => {
        const serialized = JSON.stringify({
            id: {
                v: 4,
                msgId: 'message-1',
                ts: 1,
                senderId: 'server-1',
                traceId: 'trace-al-message-persistence-decoding'
            },
            route: {
                topicId: 'topic-1',
                resourceId: 'resource-1',
                contextId: 'context-1'
            },
            payload: {
                typeId: 'type-1',
                resource: '{}'
            }
        });

        expect(decodePersistedALMessage(serialized).route.topicId).toBe('topic-1');
        expect(() => decodePersistedALMessage('{"route":{}}')).toThrow(TypeError);
    });

    it('rejects accessor-backed and sparse persisted fields without invoking custom behavior', () => {
        const accessorBacked = currentPersistedALMessage();
        let accessorRead = false;
        Object.defineProperty(accessorBacked, 'route', {
            enumerable: true,
            get: () => {
                accessorRead = true;
                return {};
            }
        });

        expect(() => decodePersistedALMessageValue(accessorBacked)).toThrow(/data properties/);
        expect(accessorRead).toBe(false);

        const sparseRecipients = ['session-a'];
        sparseRecipients.length = 2;
        const sparseAudience = currentPersistedALMessage();
        sparseAudience.targets = {
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            recipientPeerIds: sparseRecipients
        };

        expect(decodeALMessageValue(sparseAudience).left?.code).toBe('malformed');
        expect(() => decodePersistedALMessageValue(sparseAudience)).toThrow(TypeError);
    });
});

function currentPersistedALMessage(): MutablePersistedALMessageFixture {
    return {
        id: {
            v: 4,
            msgId: 'message-1',
            ts: 1,
            senderId: 'server-1',
            traceId: 'trace-persistence-decoding'
        },
        route: {
            topicId: 'topic-1',
            resourceId: 'resource-1',
            contextId: 'context-1'
        },
        targets: {
            mode: 'broadcast',
            scope: 'all'
        },
        payload: {
            typeId: 'type-1',
            resource: '{}'
        }
    };
}
