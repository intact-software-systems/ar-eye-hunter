import { describe, expect, it, vi } from 'vitest';

import { RallarServerWsFacade } from '@shared-server/rallar-facade/ws-topic-router.ts';
import { InMemoryRallarCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';
import { installRallarCrdtWsTopics } from '@shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts';
import {
    AL_CONTROL_NACK_TYPE_ID,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALRoute,
    RALLAR_CRDT_APP_TOPIC_ID,
    RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID,
    RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    RALLAR_CRDT_ROOM_TOPIC_ID,
    RALLAR_CRDT_UPDATE_TYPE_ID,
    WsQueueBoxServerService,
    type ALMessage,
    type EncodedJsonWebSocketMessage,
    type RallarCrdtCatchUpResponseEnvelope,
    type RallarCrdtDocumentRef,
    type RallarCrdtOperationBatch,
    type RallarCrdtUpdateEnvelope,
    type WsServerTargetResolver
} from '@shared/mod.ts';

const roomRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1'
};

const roomDocumentRef: RallarCrdtDocumentRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'room-1',
    roomRef
};

const principalDocumentRef: RallarCrdtDocumentRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    scope: 'principal',
    documentType: 'checklist',
    documentId: 'principal-doc',
    principalId: 'principal-1'
};

describe('installRallarCrdtWsTopics', () => {
    it('accepts room CRDT updates only through durable mutation ingress', async () => {
        const accepted = vi.fn();
        const enqueueUpdate = vi.fn().mockResolvedValue(undefined);
        const { facade, socket, outbox } = createFacade({
            authorizeRoomMessage: () => true
        });
        const enqueueOutbox = vi.spyOn(outbox, 'enqueue');
        const enqueueOutboxIfAbsent = vi.spyOn(outbox, 'enqueueIfAbsent');
        installRallarCrdtWsTopics(facade, {
            allowedDocumentTypes: ['checklist'],
            onAcceptedEnvelope: accepted,
            mutationIngress: { enqueueUpdate }
        });
        const update = createUpdateEnvelope();
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute(RALLAR_CRDT_ROOM_TOPIC_ID, 'room-1', update.updateId),
            'room',
            RALLAR_CRDT_UPDATE_TYPE_ID,
            update,
            {
                groupRef: roomRef
            }
        );

        await facade.handle(message);

        expect(accepted).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'update',
                envelope: update,
                trusted: expect.objectContaining({
                    senderId: 'peer-1',
                    sessionId: 'peer-1',
                    topicId: RALLAR_CRDT_ROOM_TOPIC_ID,
                    typeId: RALLAR_CRDT_UPDATE_TYPE_ID,
                    roomId: 'room-1',
                    roomRef
                })
            })
        );
        expect(enqueueUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'update',
                envelope: update
            })
        );
        expect(socket.sent).toEqual([]);
        expect(enqueueOutbox).not.toHaveBeenCalled();
        expect(enqueueOutboxIfAbsent).not.toHaveBeenCalled();
    });

    it('rejects schema-invalid room updates before fanout', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { facade, socket } = createFacade({
                authorizeRoomMessage: () => true
            });
            installRallarCrdtWsTopics(facade, {
                allowedDocumentTypes: ['checklist']
            });
            const update = createUpdateEnvelope({
                operationVersion: 99
            });
            const message = newALBroadcastMessage(
                'peer-1',
                newALRoute(RALLAR_CRDT_ROOM_TOPIC_ID, 'room-1', update.updateId),
                'room',
                RALLAR_CRDT_UPDATE_TYPE_ID,
                update,
                {
                    groupRef: roomRef
                }
            );

            await facade.handle(message);

            expect(socket.sent).toHaveLength(1);
            expect(socket.sent[0].connectionId).toBe('conn-1');
            expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
        }
        finally {
            warn.mockRestore();
        }
    });

    it('rejects unauthorized room CRDT updates through the existing room authorizer', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { facade, socket } = createFacade({
                authorizeRoomMessage: () => false
            });
            installRallarCrdtWsTopics(facade);
            const update = createUpdateEnvelope();
            const message = newALBroadcastMessage(
                'peer-1',
                newALRoute(RALLAR_CRDT_ROOM_TOPIC_ID, 'room-1', update.updateId),
                'room',
                RALLAR_CRDT_UPDATE_TYPE_ID,
                update,
                {
                    groupRef: roomRef
                }
            );

            await facade.handle(message);

            expect(socket.sent).toHaveLength(1);
            expect(socket.sent[0].connectionId).toBe('conn-1');
            expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
        }
        finally {
            warn.mockRestore();
        }
    });

    it('rejects policy-disabled live room updates before fanout', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { facade, socket } = createFacade({
                authorizeRoomMessage: () => true
            });
            installRallarCrdtWsTopics(facade, {
                policies: [
                    {
                        documentType: 'checklist',
                        rollout: 'durable-beta',
                        flags: {
                            ws: false
                        }
                    }
                ]
            });
            const update = createUpdateEnvelope();
            const message = newALBroadcastMessage(
                'peer-1',
                newALRoute(RALLAR_CRDT_ROOM_TOPIC_ID, 'room-1', update.updateId),
                'room',
                RALLAR_CRDT_UPDATE_TYPE_ID,
                update,
                {
                    groupRef: roomRef
                }
            );

            await facade.handle(message);

            expect(socket.sent).toHaveLength(1);
            expect(socket.sent[0].connectionId).toBe('conn-1');
            expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
        }
        finally {
            warn.mockRestore();
        }
    });

    it('rejects unsupported principal live fanout even when app CRDT ' + 'documents are enabled', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { facade, socket } = createFacade();
            installRallarCrdtWsTopics(facade, {
                allowAppDocuments: true
            });
            const update = createUpdateEnvelope({
                document: {
                    applicationId: 'rallar-test',
                    workspaceId: 'main',
                    scope: 'principal',
                    documentType: 'checklist',
                    documentId: 'principal-doc',
                    principalId: 'principal-1'
                }
            });
            const message = newALBroadcastMessage(
                'peer-1',
                newALRoute(RALLAR_CRDT_APP_TOPIC_ID, 'rallar-test', update.updateId),
                'all',
                RALLAR_CRDT_UPDATE_TYPE_ID,
                update
            );

            await facade.handle(message);

            expect(socket.sent).toHaveLength(1);
            expect(socket.sent[0].connectionId).toBe('conn-1');
            expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
        }
        finally {
            warn.mockRestore();
        }
    });

    it('rejects oversized CRDT updates', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { facade, socket } = createFacade({
                authorizeRoomMessage: () => true
            });
            installRallarCrdtWsTopics(facade, {
                maxUpdateBytes: 96
            });
            const update = createUpdateEnvelope();
            const message = newALBroadcastMessage(
                'peer-1',
                newALRoute(RALLAR_CRDT_ROOM_TOPIC_ID, 'room-1', update.updateId),
                'room',
                RALLAR_CRDT_UPDATE_TYPE_ID,
                update,
                {
                    groupRef: roomRef
                }
            );

            await facade.handle(message);

            expect(socket.sent).toHaveLength(1);
            expect(socket.sent[0].connectionId).toBe('conn-1');
            expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
        }
        finally {
            warn.mockRestore();
        }
    });

    it('rejects Buffer-shaped raw binary payloads inside CRDT operations', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { facade, socket } = createFacade({
                authorizeRoomMessage: () => true
            });
            installRallarCrdtWsTopics(facade);
            const update = createUpdateEnvelope({
                payload: {
                    kind: 'batch',
                    operations: [
                        {
                            kind: 'map.set',
                            path: ['files'],
                            key: 'raw',
                            value: {
                                type: 'Buffer',
                                data: [1, 2, 3]
                            }
                        }
                    ]
                }
            });
            const message = newALBroadcastMessage(
                'peer-1',
                newALRoute(RALLAR_CRDT_ROOM_TOPIC_ID, 'room-1', update.updateId),
                'room',
                RALLAR_CRDT_UPDATE_TYPE_ID,
                update,
                {
                    groupRef: roomRef
                }
            );

            await facade.handle(message);

            expect(socket.sent).toHaveLength(1);
            expect(socket.sent[0].connectionId).toBe('conn-1');
            expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
        }
        finally {
            warn.mockRestore();
        }
    });

    it('hands accepted updates to durable mutation ingress without direct append ' + 'or fanout', async () => {
        const { facade, socket } = createFacade({
            authorizeRoomMessage: () => true
        });
        const logRepository = new InMemoryRallarCrdtLogRepository({
            now: () => 2_000,
            serverId: 'server-1'
        });
        const accepted: unknown[] = [];
        installRallarCrdtWsTopics(facade, {
            logRepository,
            mutationIngress: {
                enqueueUpdate: (entry) => {
                    accepted.push(entry);
                    return Promise.resolve();
                }
            }
        });
        const update = createUpdateEnvelope();
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute(RALLAR_CRDT_ROOM_TOPIC_ID, 'room-1', update.updateId),
            'room',
            RALLAR_CRDT_UPDATE_TYPE_ID,
            update,
            {
                groupRef: roomRef
            }
        );

        await facade.handle(message);

        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toMatchObject({ kind: 'update', envelope: update });
        expect(socket.sent).toHaveLength(0);
        expect((await logRepository.readDocumentMetadata(roomDocumentRef))?.updateCount).toBeUndefined();
    });

    it('responds to durable WS catch-up requests from the append log', async () => {
        const { facade, socket } = createFacade({
            authorizeRoomMessage: () => true
        });
        const logRepository = new InMemoryRallarCrdtLogRepository({
            now: () => 2_000,
            serverId: 'server-1'
        });
        await logRepository.append({
            update: createUpdateEnvelope({
                updateId: 'update-1',
                lamport: 1
            }),
            trusted: {
                actorId: 'peer-1',
                principalId: 'peer-1',
                sessionId: 'session-1',
                serverId: 'server-1',
                authorizationScope: 'room'
            }
        });
        await logRepository.append({
            update: createUpdateEnvelope({
                updateId: 'update-2',
                lamport: 2
            }),
            trusted: {
                actorId: 'peer-1',
                principalId: 'peer-1',
                sessionId: 'session-1',
                serverId: 'server-1',
                authorizationScope: 'room'
            }
        });
        installRallarCrdtWsTopics(facade, {
            logRepository
        });
        const request = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: roomDocumentRef,
            requestId: 'catch-up-1',
            replicaId: 'replica-late',
            createdAtEpochMs: 3_000,
            afterSequence: 1,
            maxUpdateCount: 10,
            includeSnapshot: true
        };
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute(RALLAR_CRDT_ROOM_TOPIC_ID, 'room-1', request.requestId),
            'room',
            RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID,
            request,
            {
                groupRef: roomRef
            }
        );

        await facade.handle(message);

        const responseMessage = socket.sent.find((entry) => entry.data.payload.typeId === RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID);
        expect(responseMessage?.connectionId).toBe('conn-1');
        const response = JSON.parse(responseMessage?.data.payload.resource ?? '{}') as RallarCrdtCatchUpResponseEnvelope;
        expect(response.requestId).toBe('catch-up-1');
        expect(response.page.records.map((record) => record.update.updateId)).toEqual(['update-2']);
        expect(response.page.lastSequence).toBe(2);
    });

    it('hands principal updates to durable mutation ingress without live fanout', async () => {
        const { facade, socket } = createFacade();
        const logRepository = new InMemoryRallarCrdtLogRepository({
            now: () => 2_000,
            serverId: 'server-1'
        });
        const accepted: unknown[] = [];
        installRallarCrdtWsTopics(facade, {
            allowPrincipalDocuments: true,
            logRepository,
            mutationIngress: {
                enqueueUpdate: (entry) => {
                    accepted.push(entry);
                    return Promise.resolve();
                }
            }
        });
        const update = createUpdateEnvelope({
            document: principalDocumentRef
        });
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute(RALLAR_CRDT_APP_TOPIC_ID, 'rallar-test', update.updateId),
            'all',
            RALLAR_CRDT_UPDATE_TYPE_ID,
            update
        );

        await facade.handle(message);

        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toMatchObject({ kind: 'update', envelope: update });
        expect(socket.sent).toHaveLength(0);
        expect((await logRepository.readDocumentMetadata(principalDocumentRef))?.updateCount).toBeUndefined();
    });

    it('does not run lifecycle rejection or fanout before AppInbox processing', async () => {
        const { facade, socket } = createFacade({
            authorizeRoomMessage: () => true
        });
        const logRepository = new InMemoryRallarCrdtLogRepository({
            now: () => 2_000
        });
        await logRepository.updateDocumentLifecycle({
            document: roomDocumentRef,
            lifecycle: 'archived',
            changedAtEpochMs: 1_500
        });
        const accepted: unknown[] = [];
        installRallarCrdtWsTopics(facade, {
            logRepository,
            mutationIngress: {
                enqueueUpdate: (entry) => {
                    accepted.push(entry);
                    return Promise.resolve();
                }
            }
        });
        const update = createUpdateEnvelope();
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute(RALLAR_CRDT_ROOM_TOPIC_ID, 'room-1', update.updateId),
            'room',
            RALLAR_CRDT_UPDATE_TYPE_ID,
            update,
            {
                groupRef: roomRef
            }
        );

        await facade.handle(message);

        expect(accepted).toHaveLength(1);
        expect(socket.sent).toHaveLength(0);
    });
});

function createFacade(options?: ConstructorParameters<typeof RallarServerWsFacade>[1]) {
    const socket = new RecordingJsonWebSocketServer();
    const inbox = new InMemoryQueueBox(new Map());
    const outbox = new InMemoryQueueBox(new Map());
    const service = new WsQueueBoxServerService(inbox, outbox, socket, 'server-1', {
        targetResolver: createTargetResolver()
    });
    const facade = new RallarServerWsFacade(service, options);

    return {
        facade,
        service,
        socket,
        inbox,
        outbox
    };
}

class RecordingJsonWebSocketServer extends JsonWebSocketServer {
    readonly sent: Array<{ connectionId: string; data: ALMessage; }> = [];

    override sendEncoded(connectionId: string, encoded: EncodedJsonWebSocketMessage): void {
        this.sent.push({
            connectionId,
            data: JSON.parse(encoded.text) as ALMessage
        });
    }
}

function createTargetResolver(): WsServerTargetResolver {
    const connectionIdByPeerId: Record<string, string> = {
        'peer-1': 'conn-1',
        'peer-2': 'conn-2',
        'peer-3': 'conn-3'
    };

    const toRecipients = () =>
        Object.entries(connectionIdByPeerId).map(([peerId, connectionId]) => ({
            peerId,
            connectionId
        }));

    return {
        resolvePeerRecipients: (peerId: string) => {
            const connectionId = connectionIdByPeerId[peerId];
            return connectionId
                ? [
                    {
                        peerId,
                        connectionId
                    }
                ]
                : [];
        },
        resolveGroupRecipients: () => toRecipients(),
        resolveBroadcastRecipients: () => toRecipients()
    };
}

function createUpdateEnvelope(overrides: Partial<RallarCrdtUpdateEnvelope> = {}): RallarCrdtUpdateEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: roomDocumentRef,
        updateId: 'update-1',
        replicaId: 'replica-a',
        actorId: 'claimed-actor',
        sessionId: 'claimed-session',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 1_000,
        payload: createOperationBatch(),
        ...overrides
    };
}

function createOperationBatch(): RallarCrdtOperationBatch {
    return {
        kind: 'batch',
        operations: [
            {
                kind: 'register.set',
                path: ['title'],
                policy: 'lww',
                value: 'Inspect north entrance'
            }
        ]
    };
}
