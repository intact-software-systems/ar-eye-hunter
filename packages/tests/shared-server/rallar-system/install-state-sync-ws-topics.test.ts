import { installStateSyncWsTopics } from '@shared-server/rallar-system/state-sync/install-state-sync-ws-topics.ts';
import { newALBroadcastMessage, newALEventRoute, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { OnWebSocketServerMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { describe, expect, it, vi } from 'vitest';
import { createGroupSnapshot } from '../group-state/snapshot/group-state-snapshot-test-fixtures.ts';
import { createClientSnapshot } from '../rest-state-snapshot-read-test-fixtures.ts';

interface InvalidStateSyncCase {
    readonly name: string;
    readonly callbackTopicId: string;
    readonly message: ALMessage;
}

describe('state-sync websocket topic installation', () => {
    it.each(createInvalidStateSyncCases())(
        'rejects $name through inbox and outbox before observation, cache mutation, or publication',
        async ({ callbackTopicId, message }) => {
            const service = new CapturingWsService();
            const observeGroupSnapshot = vi.fn();
            const observeClientSnapshot = vi.fn();
            const setClientSnapshot = vi.spyOn(
                clientStateSnapshotsRepository,
                'setClientStateSnapshotByPrincipalId'
            );
            const setGroupSnapshot = vi.spyOn(
                groupStateSnapshotsRepository,
                'setGroupStateSnapshot'
            );
            installStateSyncWsTopics(service, {
                observeGroupSnapshot,
                observeClientSnapshot
            });
            const webSocketServer = createWebSocketServer();

            await service.getInboxCallback(callbackTopicId).onMessage(
                message,
                {} as ResourceEntry,
                webSocketServer
            );
            await service.getOutboxCallback(callbackTopicId).onMessage(
                message,
                {} as ResourceEntry,
                webSocketServer
            );

            expect(observeGroupSnapshot).not.toHaveBeenCalled();
            expect(observeClientSnapshot).not.toHaveBeenCalled();
            expect(setClientSnapshot).not.toHaveBeenCalled();
            expect(setGroupSnapshot).not.toHaveBeenCalled();
            expect(webSocketServer.broadcast).not.toHaveBeenCalled();
            expect(webSocketServer.encode).not.toHaveBeenCalled();
            expect(webSocketServer.sendEncoded).not.toHaveBeenCalled();
        }
    );
});

class CapturingWsService {
    private readonly inboxCallbacks = new Map<string, OnWebSocketServerMessageCallback<ALMessage>>();
    private readonly outboxCallbacks = new Map<string, OnWebSocketServerMessageCallback<ALMessage>>();

    onInboxMessageDo(
        topicId: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): this {
        this.inboxCallbacks.set(topicId, callback);
        return this;
    }

    onOutboxMessageDo(
        topicId: string,
        callback: OnWebSocketServerMessageCallback<ALMessage>
    ): this {
        this.outboxCallbacks.set(topicId, callback);
        return this;
    }

    getInboxCallback(topicId: string): OnWebSocketServerMessageCallback<ALMessage> {
        return requireCallback(this.inboxCallbacks, topicId, 'inbox');
    }

    getOutboxCallback(topicId: string): OnWebSocketServerMessageCallback<ALMessage> {
        return requireCallback(this.outboxCallbacks, topicId, 'outbox');
    }
}

function createInvalidStateSyncCases(): readonly InvalidStateSyncCase[] {
    const groupSnapshot = createGroupSnapshot(3, []);
    const clientSnapshot = createClientSnapshot(3);
    const malformedJson = newALBroadcastMessage(
        'server-1',
        newALEventRoute(AppTopics.groupStateSnapshot, 'group-1', 'malformed-json'),
        'room',
        AppTopics.groupStateSnapshot,
        groupSnapshot
    );

    return [
        {
            name: 'malformed JSON',
            callbackTopicId: AppTopics.groupStateSnapshot,
            message: {
                ...malformedJson,
                payload: { ...malformedJson.payload, resource: '{' }
            }
        },
        {
            name: 'malformed authoritative client shape',
            callbackTopicId: AppTopics.clientStateSnapshot,
            message: newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.clientStateSnapshot, 'alice', 'malformed-client'),
                'all',
                AppTopics.clientStateSnapshot,
                { forged: true }
            )
        },
        {
            name: 'mismatched authoritative client audience',
            callbackTopicId: AppTopics.clientStateSnapshot,
            message: {
                ...newALBroadcastMessage(
                    'server-1',
                    newALEventRoute(AppTopics.clientStateSnapshot, 'alice', 'wrong-client-audience'),
                    'all',
                    AppTopics.clientStateSnapshot,
                    clientSnapshot
                ),
                targets: {
                    mode: 'broadcast',
                    scope: 'principal',
                    principalRef: {
                        applicationId: clientSnapshot.principal.applicationId,
                        workspaceId: clientSnapshot.principal.workspaceId,
                        principalId: 'bob'
                    }
                }
            }
        },
        {
            name: 'malformed authoritative group shape',
            callbackTopicId: AppTopics.groupStateSnapshot,
            message: newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateSnapshot, 'group-1', 'malformed-group'),
                'room',
                AppTopics.groupStateSnapshot,
                { forged: true },
                { groupRef: groupSnapshot.group }
            )
        },
        {
            name: 'mismatched authoritative group audience',
            callbackTopicId: AppTopics.groupStateSnapshot,
            message: newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateSnapshot, 'group-1', 'wrong-audience'),
                'room',
                AppTopics.groupStateSnapshot,
                groupSnapshot,
                {
                    groupRef: {
                        ...groupSnapshot.group,
                        groupId: 'different-group'
                    }
                }
            )
        },
        {
            name: 'malformed group delta envelope',
            callbackTopicId: AppTopics.groupStateEvent,
            message: newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateEvent, 'group-1', 'malformed-delta'),
                'room',
                AppTopics.groupStateEvent,
                { forged: true },
                { groupRef: groupSnapshot.group }
            )
        },
        {
            name: 'unsupported payload type on a state-sync route',
            callbackTopicId: AppTopics.groupStateSnapshot,
            message: newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateSnapshot, 'group-1', 'unsupported-type'),
                'room',
                'unsupported.state-sync.v1',
                { forged: true }
            )
        },
        {
            name: 'recognized state-sync payload type on a user route',
            callbackTopicId: AppTopics.groupStateSnapshot,
            message: newALBroadcastMessage(
                'server-1',
                newALRoute('app.todo', 'all', 'reverse-mismatch'),
                'all',
                AppTopics.groupStateSnapshot,
                groupSnapshot
            )
        }
    ];
}

function requireCallback(
    callbacks: ReadonlyMap<string, OnWebSocketServerMessageCallback<ALMessage>>,
    topicId: string,
    direction: 'inbox' | 'outbox'
): OnWebSocketServerMessageCallback<ALMessage> {
    const callback = callbacks.get(topicId);
    if (!callback) {
        throw new Error(`Missing ${direction} callback for ${topicId}`);
    }
    return callback;
}

function createWebSocketServer(): JsonWebSocketServer {
    const webSocketServer = new JsonWebSocketServer();
    vi.spyOn(webSocketServer, 'broadcast');
    vi.spyOn(webSocketServer, 'encode');
    vi.spyOn(webSocketServer, 'sendEncoded');
    return webSocketServer;
}
