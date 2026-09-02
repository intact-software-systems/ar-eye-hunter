import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import { InMemoryRallarCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';

import { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import { authenticationRequired } from '../../src/services/request-auth-service.ts';

import {
    constructApiV1RouteInstallers,
    type ApiV1RouteInstallerOperations,
    type ApiV1RouteInstallerRuntime,
    type ApiV1RouteInstallerTopology,
    type CreateApiV1RouteInstallersInput
} from '../../src/composition/create-api-v1-route-installers.ts';

Deno.test('route installers mount representative API and websocket behavior in order', async () => {
    const app = new Hono();
    const installers = constructApiV1RouteInstallers(createInput(), TEST_OPERATIONS);

    installers.webSocket(app);
    for (const install of installers.rest) {
        install(app);
    }

    assert.equal((await app.request('/api/ws/session-1')).status, 426);
    assert.equal((await app.request('/api/config')).status, 200);
    assert.equal((await app.request('/api/webrtc/ice')).status, 401);
    assert.equal(
        (await app.request('/api/state/apps/app/workspaces/workspace/clients/alice')).status,
        400
    );
    assert.equal(
        (await app.request('/api/state/apps/app/workspaces/workspace/groups/group')).status,
        400
    );
    assert.equal(
        (await app.request('/api/state/apps/app/workspaces/workspace/graphs/global?refresh=bogus'))
            .status,
        400
    );
    assert.equal(
        (await app.request('/api/state/apps/app/workspaces/workspace/stats/summary')).status,
        401
    );
    assert.equal((await app.request('/api/admin/operations/overview')).status, 401);
    assert.equal(
        (await app.request('/api/admin/support/explain/queue-item', { method: 'POST' })).status,
        401
    );
    assert.equal((await app.request('/api/crdt/catch-up', { method: 'POST' })).status, 401);
    assert.equal((await app.request('/api/docs')).status, 200);
});

const TEST_OPERATIONS: ApiV1RouteInstallerOperations<ApiV1RouteInstallerRuntime> = {
    requireApiAuthSession: rejectUnauthenticated,
    requireWsAuthSession: rejectUnauthenticated
};

function createInput(): CreateApiV1RouteInstallersInput<ApiV1RouteInstallerRuntime, ApiV1RouteInstallerTopology> {
    return {
        runtime: {
            wsQBoxServerService: { socket: new JsonWebSocketServer() },
            authSessionRepository: {},
            appAuthInboxService: {
                registerUser: rejectUnusedOperation,
                issueSession: rejectUnusedOperation,
                logoutSession: rejectUnusedOperation,
                replayLogoutSessionWithCredentialProof: rejectUnusedOperation,
                issueWebSocketTicket: rejectUnusedOperation,
                issueAgentSessionTickets: rejectUnusedOperation,
                consumeAgentSessionTicket: rejectUnusedOperation
            },
            appClientInboxService: {
                enqueueAuthorisedWsClientConnect: rejectUnusedOperation,
                processAuthenticatedEntryUntilCompletion: rejectUnusedOperation
            },
            groupStateInboxService: {
                processAuthenticatedGroupEntryUntilCompletionResult: rejectUnusedOperation
            },
            topologyInboxService: {
                processAuthenticatedEntryUntilCompletion: rejectUnusedOperation,
                processAuthenticatedEntryUntilCompletionResult: rejectUnusedOperation,
                processAuthenticatedHttpEntryUntilCompletionResult: rejectUnusedOperation
            },
            clientStateService: {
                listEventPage: rejectUnusedOperation,
                listEvents: rejectUnusedOperation,
                listRecentEvents: rejectUnusedOperation,
                listSnapshots: rejectUnusedOperation,
                readCurrentSnapshot: rejectUnusedOperation,
                readPresenceSnapshot: rejectUnusedOperation,
                readSnapshot: rejectUnusedOperation
            },
            groupStateService: {
                listEventPage: rejectUnusedOperation,
                listEvents: rejectUnusedOperation,
                listRecentEvents: rejectUnusedOperation,
                listSnapshots: rejectUnusedOperation,
                readCurrentSnapshot: rejectUnusedOperation,
                readSnapshot: rejectUnusedOperation
            },
            clientRestSnapshotReadSelector: { read: rejectUnusedOperation },
            groupRestSnapshotReadSelector: { read: rejectUnusedOperation },
            groupsRepository: { readSnapshot: rejectUnusedOperation },
            clientsRepository: { readSnapshot: rejectUnusedOperation }
        },
        topology: createTopology(),
        admin: {
            operations: {
                overview: { execute: rejectUnusedOperation },
                queues: { execute: rejectUnusedOperation },
                realtime: { execute: rejectUnusedOperation },
                state: { execute: rejectUnusedOperation },
                crdt: { execute: rejectUnusedOperation },
                system: { execute: rejectUnusedOperation },
                metricsReset: { execute: rejectUnusedOperation },
                topologyRecompute: { execute: rejectUnusedOperation },
                prune: { execute: rejectUnusedOperation },
                crdtIntegrity: { execute: rejectUnusedOperation },
                crdtDebugExport: { execute: rejectUnusedOperation },
                crdtCompact: { execute: rejectUnusedOperation },
                crdtLifecycle: { execute: rejectUnusedOperation },
                crdtErase: { execute: rejectUnusedOperation }
            },
            support: {
                explainClient: rejectUnusedOperation,
                explainGroup: rejectUnusedOperation,
                explainRequest: rejectUnusedOperation,
                explainCrdtDocument: rejectUnusedOperation,
                explainQueueItem: rejectUnusedOperation
            },
            statistics: {
                readWorkspaceSummary: rejectUnusedOperation,
                readGroupStats: rejectUnusedOperation,
                readMyRealtimeStatus: rejectUnusedOperation
            }
        },
        crdtLogRepository: new InMemoryRallarCrdtLogRepository({ now: () => 1_000 }),
        crdtMutations: {
            writeCrdtAdminMutation: () => Promise.reject(new Error('mutation not used'))
        },
        authUserRepository: new AuthUserRepository(new UnusedRuntimeStateRepository()),
        authentication: {
            adminClientIds: ['admin'],
            agentSessionTicketTtlMs: 60_000,
            rateLimits: {
                windowMs: 60_000,
                loginIp: 30,
                loginUsername: 5,
                registrationIp: 20,
                registrationUsername: 5,
                webSocketTicket: 30
            },
            registrationMode: 'public',
            sessionTtlMs: 2_592_000_000,
            staticClients: [],
            webSocketTicketTtlMs: 30_000
        },
        operatorToken: { mode: 'disabled', allowedClientIds: [], ttlMs: 86_400_000 },
        publicConfiguration: {
            apiBaseUrl: 'http://localhost:8080',
            wsBaseUrl: 'ws://localhost:8080',
            endpoints: { createWs: '/api/ws/:id' }
        },
        ice: {
            mode: 'local',
            cacheTtlMs: 300_000,
            rateLimit: { windowMs: 60_000, requests: 20 }
        },
        groupAdmission: {
            windowMs: 60_000,
            joinPrincipal: 60,
            joinGroup: 600,
            presencePrincipal: 120,
            presenceGroup: 1_200
        },
        strictReadAuthorization: false,
        nowEpochMs: () => 1_000,
        createTokenId: () => 'token-id',
        createWsAuthRequestFacts: () => ({
            requestId: 'request-id'
        })
    };
}

function createTopology(): ApiV1RouteInstallerTopology {
    return {
        topologyQuery: {
            readTopologyView: rejectUnusedOperation,
            readConfig: rejectUnusedOperation,
            readOverride: rejectUnusedOperation
        },
        topologyPlanning: {
            readTopologyPlanningAuthority: rejectUnusedOperation
        },
        adminClientIds: ['admin'],
        readAcceptedLayoutFingerprint: () => Promise.resolve(null),
        groupStateRepository: {
            readLifecyclePolicy: () => Promise.resolve({ status: 'absent' as const })
        }
    };
}

function rejectUnusedOperation<T>(): Promise<T> {
    return Promise.reject(new Error('route dependency not used'));
}

function rejectUnauthenticated<T>(): Promise<T> {
    return Promise.reject(authenticationRequired('Unauthorized: Missing bearer token'));
}

class UnusedRuntimeStateRepository implements RuntimeStateRepositoryLike {
    findEntry(): Promise<never> {
        return rejectUnusedOperation();
    }

    findAllEntries(): Promise<never> {
        return rejectUnusedOperation();
    }

    findEntriesByPrefixPage(): Promise<never> {
        return rejectUnusedOperation();
    }

    readRuntimeStateBatch(
        _selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        return rejectUnusedOperation();
    }

    upsert(): Promise<never> {
        return rejectUnusedOperation();
    }

    deleteByKey(): Promise<never> {
        return rejectUnusedOperation();
    }

    deleteExpired(): Promise<never> {
        return rejectUnusedOperation();
    }
}
