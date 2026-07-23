import { describe, expect, it } from 'vitest';
import {
    type AuditStamp,
    type ClientInstance,
    type ClientPrincipal,
    type ClientSession,
    type ClientSnapshot,
} from '@shared/api/client-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    RALLAR_CRDT_UPDATE_TYPE_ID,
} from '@shared/crdt/mod.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/mod.ts';
import { WsQueueBoxServerService } from '@shared/services/WsQueueBoxServerService.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import {
    createClientStateSnapshotReadThroughCache,
} from '@shared-server/rallar-system/services/client-state-snapshot-read-through-cache.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/middleware/RallarMiddleware.ts';
import { findCurrentClientSnapshot } from '../../../apps/api-v1/src/services/create-api-crdt-document-authorizer.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

const NOW = Date.now();

describe('Task 9 correction 4 production principal fanout', () => {
    it('fails closed while cold, then expands omitted-workspace principal to all current sessions', async () => {
        configureTestCacheRepositories();
        const repository = new ClientStateRepository(new FakeRuntimeStateRepository());
        const snapshot = clientSnapshot();
        await putSnapshot(repository, snapshot);
        const cache = createClientStateSnapshotReadThroughCache({
            clientsRepository: repository,
            now: () => NOW,
        });
        const sockets = new Map<string, string[]>();
        const webSocketServer = new JsonWebSocketServer();
        for (const id of ['alice', 'session-a', 'session-b']) {
            const sent: string[] = [];
            sockets.set(id, sent);
            webSocketServer.addConnection(
                new ConnectionContext(id, {
                    readyState: WebSocket.OPEN,
                    addEventListener: () => undefined,
                    send: (value: string) => sent.push(value),
                } as WebSocket),
            );
        }
        const queue = new InMemoryQueueBox();
        const service = new WsQueueBoxServerService(
            queue,
            queue,
            webSocketServer,
            'server-1',
            {
                targetResolver: createWsServerTargetResolver(webSocketServer, {
                    findClientSnapshotByRef: (ref) => findCurrentClientSnapshot(cache, ref),
                    now: () => NOW,
                }),
            },
        );
        const message = principalMessage();

        expect(service.sendToTargetsWithResult(message).sentCount).toBe(0);
        expect(sockets.get('alice')).toEqual([]);

        await cache.findOrLoadByRef({
            applicationId: 'app-1',
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            principalId: 'alice',
        });

        expect(service.sendToTargetsWithResult(message).recipients).toEqual([
            { peerId: 'session-a', connectionId: 'session-a' },
            { peerId: 'session-b', connectionId: 'session-b' },
        ]);
        expect(sockets.get('alice')).toEqual([]);
        expect(sockets.get('session-a')).toHaveLength(1);
        expect(sockets.get('session-b')).toHaveLength(1);
    });
});

function principalMessage() {
    const document = {
        applicationId: 'app-1',
        scope: 'principal' as const,
        documentType: 'checklist',
        documentId: 'principal-document',
        principalId: 'alice',
    };
    const update = {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document,
        updateId: 'update-1',
        replicaId: 'replica-1',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 1,
        payload: {
            kind: 'batch' as const,
            operations: [{
                kind: 'register.set' as const,
                path: ['title'],
                policy: 'lww' as const,
                value: 'current',
            }],
        },
    };
    return newALUnicastMessage(
        'server-1',
        newALRoute('rallar.crdt.app', 'app-1', update.updateId),
        'alice',
        RALLAR_CRDT_UPDATE_TYPE_ID,
        update,
    );
}

async function putSnapshot(
    repository: ClientStateRepository,
    snapshot: ClientSnapshot,
): Promise<void> {
    await repository.insertPrincipal(snapshot.principal);
    for (const instance of snapshot.instances) await repository.insertInstance(instance);
    for (const session of snapshot.activeSessions) await repository.insertSession(session);
}

function clientSnapshot(): ClientSnapshot {
    const principal: ClientPrincipal = {
        applicationId: 'app-1',
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
        principalId: 'alice',
        username: 'alice',
        displayName: 'Alice',
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        roles: [],
        metadata: {},
        status: 'active',
        disabled: null,
        deleted: null,
        snapshotVersion: 1,
        profileVersion: 1,
        presenceVersion: 1,
        created: audit(),
        updated: audit(),
        lastSeenAtEpochMs: NOW,
    };
    const instance: ClientInstance = {
        applicationId: principal.applicationId,
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        clientInstanceId: 'instance-1',
        status: 'active',
        revoked: null,
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        registered: audit(),
        updated: audit(),
    };
    const toSession = (sessionId: string): ClientSession => ({
        applicationId: principal.applicationId,
        workspaceId: principal.workspaceId,
        principalId: principal.principalId,
        clientInstanceId: instance.clientInstanceId,
        sessionId,
        generationId: `${sessionId}-generation`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: sessionId,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: NOW,
        expiresAtEpochMs: NOW + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    });
    return {
        stateRevision: 1,
        principal,
        instances: [instance],
        activeSessions: [toSession('session-a'), toSession('session-b')],
        isOnline: true,
        activeSessionCount: 2,
        lastSeenAtEpochMs: NOW,
    };
}

function audit(): AuditStamp {
    return {
        atEpochMs: 1,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
