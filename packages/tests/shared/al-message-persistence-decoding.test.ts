import { decodePersistedALMessage, decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { describe, expect, it } from 'vitest';

interface MutablePersistedALMessageFixture {
    id: {
        v: number;
        msgId: string;
        ts: number;
        senderId: string;
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
        expectInvalidPersistedALMessage({
            id: {
                v: 2,
                msgId: 'message-1',
                ts: 1,
                senderId: 'server-1'
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
        }, /workspace/);
    });

    it('rejects a room broadcast without a group ref', () => {
        expect(() =>
            decodePersistedALMessageValue({
                id: {
                    v: 2,
                    msgId: 'message-1',
                    ts: 1,
                    senderId: 'server-1'
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
                    v: 2,
                    msgId: 'message-1',
                    ts: 1,
                    senderId: 'server-1'
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

    it('accepts the current principal broadcast target shape', () => {
        expect(() =>
            decodePersistedALMessageValue({
                id: {
                    v: 2,
                    msgId: 'message-1',
                    ts: 1,
                    senderId: 'server-1'
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
                v: 2,
                msgId: 'message-1',
                ts: 1,
                senderId: 'server-1'
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

        expect(() => decodePersistedALMessageValue(sparseAudience)).toThrow(/fixed recipients/);
    });
});

function expectInvalidPersistedALMessage(value: object, message: RegExp): void {
    expect(() => decodePersistedALMessageValue(value)).toThrow(message);
}

function currentPersistedALMessage(): MutablePersistedALMessageFixture {
    return {
        id: {
            v: 2,
            msgId: 'message-1',
            ts: 1,
            senderId: 'server-1'
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
