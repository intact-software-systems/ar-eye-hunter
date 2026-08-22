import assert from 'node:assert/strict';

import { Hono } from 'jsr:@hono/hono@4.11.9';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { toUnavailableAppInboxFailure, type AppInboxFailure } from '@shared-server/rallar-system/services/app-inbox-failure.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarCrdtDocumentMetadata, RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import { Either } from '@shared/resilience/Either.ts';

import { createApiAdminMutationGateway, type CreateApiAdminMutationGatewayInput } from '../../../src/admin-operations/create-api-admin-mutation-gateway.ts';
import * as adminOperationsRoutes from '../../../src/admin-operations/register-admin-operations-routes.ts';
import type { CrdtAdminMutationInput, CrdtAdminPublicResult } from '../../../src/crdt/create-crdt-admin-mutations.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const ADMIN_SESSION = {
    clientId: 'platform-admin',
    username: 'admin',
    accessToken: 'access-token',
    sessionId: 'admin-session',
    issuedAtEpochMs: NOW_EPOCH_MS - 1_000,
    expiresAtEpochMs: NOW_EPOCH_MS + 60_000
} satisfies IssuedAuthSession;
const CRDT_DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'map',
    documentId: 'document-1'
};
const CRDT_METADATA: RallarCrdtDocumentMetadata = {
    document: CRDT_DOCUMENT,
    documentKey: 'app-1/workspace-1/room/map/document-1',
    documentRevision: 1,
    lifecycle: 'active',
    createdAtEpochMs: NOW_EPOCH_MS,
    updatedAtEpochMs: NOW_EPOCH_MS,
    archivedAtEpochMs: null,
    destroyedAtEpochMs: null,
    lastAppendSequence: 0,
    updateCount: 0,
    snapshotCount: 1,
    storedUpdateBytes: 0,
    retention: null,
    quota: null,
    projectionIds: []
};

Deno.test('admin operations routes reject unauthenticated requests with 401', async () => {
    const app = createApp({
        requireApiAuthSession: () => Promise.reject(new Error('Unauthorized: Missing bearer token'))
    });

    const response = await app.request('/api/admin/operations/overview');

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        error: 'Unauthorized: Missing bearer token'
    });
});

Deno.test('admin operations routes reject authenticated non-admin requests with 403', async () => {
    const app = createApp({
        requireApiAuthSession: () =>
            Promise.resolve({
                ...ADMIN_SESSION,
                clientId: 'regular-client'
            })
    });

    const response = await app.request('/api/admin/operations/overview', {
        headers: {
            authorization: 'Bearer regular-token',
            'x-client-id': 'regular-client'
        }
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
        error: 'Forbidden: platform admin authorization required'
    });
});

Deno.test('admin operations overview returns the service overview payload', async () => {
    const app = createApp();

    const response = await app.request('/api/admin/operations/overview', {
        headers: {
            authorization: 'Bearer admin-token',
            'x-client-id': 'platform-admin'
        }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        generatedAtEpochMs: NOW_EPOCH_MS,
        serverId: 'test-server',
        warnings: [],
        health: { status: 'ok' }
    });
});

Deno.test(
    'admin operations scoped state route forwards application and workspace scope',
    async () => {
        const calls: unknown[] = [];
        const app = createApp({
            operations: {
                readState: (input: adminOperationsRoutes.AdminOperationReadInput) => {
                    calls.push(input);
                    return Promise.resolve({
                        generatedAtEpochMs: NOW_EPOCH_MS,
                        serverId: 'test-server',
                        scope: input.scope,
                        warnings: [],
                        clients: { totalPrincipals: 0, onlinePrincipals: 0, activeSessions: 0 },
                        groups: { activeGroups: 0, totalActiveMembers: 0, onlineMembers: 0 },
                        events: { recentClientEvents: 0, recentGroupEvents: 0 }
                    });
                }
            }
        });

        const response = await app.request(
            '/api/admin/operations/state/apps/app-1/workspaces/workspace-1',
            {
                headers: {
                    authorization: 'Bearer admin-token',
                    'x-client-id': 'platform-admin'
                }
            }
        );

        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).scope, {
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        });
        assert.deepEqual(calls, [
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1'
                },
                adminSession: ADMIN_SESSION
            }
        ]);
    }
);

Deno.test('admin operations metrics reset forwards request body and admin session', async () => {
    const calls: unknown[] = [];
    const app = createApp({
        operations: {
            resetMetrics: (input: adminOperationsRoutes.AdminOperationWriteInput<unknown>) => {
                calls.push(input);
                return Promise.resolve({
                    generatedAtEpochMs: NOW_EPOCH_MS,
                    serverId: 'test-server',
                    warnings: [],
                    operation: 'metrics.reset',
                    status: 'completed',
                    changed: true,
                    before: { rtcTopology: { recomputeCount: 2 } },
                    after: { rtcTopology: { recomputeCount: 0 } }
                });
            }
        }
    });

    const response = await app.request('/api/admin/operations/metrics/reset', {
        method: 'POST',
        headers: {
            authorization: 'Bearer admin-token',
            'x-client-id': 'platform-admin',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            requestId: 'reset-1',
            categories: ['rtc-topology'],
            reason: 'operator-test'
        })
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).changed, true);
    assert.deepEqual(calls, [
        {
            request: {
                requestId: 'reset-1',
                categories: ['rtc-topology'],
                reason: 'operator-test'
            },
            adminSession: ADMIN_SESSION
        }
    ]);
});

Deno.test('admin prune pending completion preserves its typed 503 response', async () => {
    const recording = createRecordingGateway({
        pruneExpired: () => Promise.resolve(Either.ofLeft(toUnavailableAppInboxFailure()))
    });
    const app = createApp({ operations: { pruneExpired: recording.gateway.pruneExpired } });

    const response = await app.request(
        '/api/admin/operations/maintenance/prune-expired/requests/pending-prune-request-0001',
        {
            method: 'POST',
            headers: {
                authorization: 'Bearer admin-token',
                'x-client-id': 'platform-admin',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ dryRun: false })
        }
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
        type: 'api-mutation-failure',
        version: 'canonical.v1',
        status: 503,
        code: 'app-inbox-unavailable',
        message: 'App inbox entry did not complete within the wait budget',
        issues: null,
        denial: null,
        retry: {
            kind: 'unavailable',
            attempts: null,
            lane: null,
            queueAgeMs: null,
            dueAgeMs: null,
            retryAfterMs: null
        }
    });
});

Deno.test(
    'admin topology recompute materializes winner facts once across renewed credentials',
    async () => {
        const completed = new Map<
            string,
            Either<AppInboxFailure, {
                status: 'queued';
                groupRef: GroupRef;
                requestId: string;
                outboxId: string;
            }>
        >();
        let capturedAtEpochMs = NOW_EPOCH_MS;
        let materializations = 0;
        const recording = createRecordingGateway({
            topology: async (reservation) => {
                const key = `${reservation.operation}:${reservation.callerId}:${reservation.requestId}`;
                const existing = completed.get(key);
                if (existing !== undefined) {
                    return existing;
                }
                const command = await reservation.materialize();
                materializations += 1;
                const result = Either.ofRight<AppInboxFailure, {
                    status: 'queued';
                    groupRef: GroupRef;
                    requestId: string;
                    outboxId: string;
                }>({
                    status: 'queued' as const,
                    groupRef: command.groupRef,
                    requestId: command.requestId,
                    outboxId: `${reservation.callerId}:outbox`
                });
                completed.set(key, result);
                return result;
            },
            now: () => {
                capturedAtEpochMs += 1;
                return capturedAtEpochMs;
            }
        });
        const request = {
            groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' },
            options: { topologyKind: 'tree' as const },
            publish: true
        };

        const first = await recording.gateway.recomputeTopology({
            adminSession: ADMIN_SESSION,
            requestId: 'admin-topology-request-0001',
            request
        });
        const renewed = {
            ...ADMIN_SESSION,
            sessionId: 'admin-renewed-session',
            issuedAtEpochMs: ADMIN_SESSION.issuedAtEpochMs + 1
        };
        await assert.doesNotReject(() =>
            recording.gateway.recomputeTopology({
                adminSession: renewed,
                requestId: 'admin-topology-request-0001',
                request
            })
        );
        const other = {
            ...ADMIN_SESSION,
            clientId: 'other-admin',
            username: 'other-admin',
            sessionId: 'other-admin-session'
        };
        const isolated = await recording.gateway.recomputeTopology({
            adminSession: other,
            requestId: 'admin-topology-request-0001',
            request
        });

        assert.equal(first.requestId, 'admin-topology-request-0001');
        assert.equal(isolated.requestId, 'admin-topology-request-0001');
        assert.equal(materializations, 2);
        assert.equal(capturedAtEpochMs, NOW_EPOCH_MS + 2);
    }
);

Deno.test('admin CRDT routes preserve compact lifecycle and erase operations', async () => {
    const recording = createRecordingGateway();
    const app = createApp({
        operations: {
            compactCrdt: recording.gateway.compactCrdt,
            updateCrdtLifecycle: recording.gateway.updateCrdtLifecycle,
            eraseCrdt: recording.gateway.eraseCrdt
        }
    });

    for (
        const [path, operation, requestId] of [
            ['/api/admin/operations/crdt/compact', 'compact', 'compact-request-0000001'],
            ['/api/admin/operations/crdt/lifecycle', 'lifecycle', 'lifecycle-request-00001'],
            ['/api/admin/operations/crdt/erase', 'erase', 'erase-request-0000000001']
        ] as const
    ) {
        const request = {};
        const response = await app.request(`${path}/requests/${requestId}`, {
            method: 'POST',
            headers: {
                authorization: 'Bearer admin-token',
                'x-client-id': 'platform-admin',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        assert.equal(response.status, 200);
        assert.deepEqual(recording.crdtCalls.at(-1), {
            operation,
            adminSession: ADMIN_SESSION,
            requestId,
            request
        });
    }
});

interface CreateRecordingGatewayInput {
    readonly pruneExpired?: CreateApiAdminMutationGatewayInput['appAdmin']['pruneExpired'];
    readonly topology?: CreateApiAdminMutationGatewayInput['appGroup'][
        'processAuthenticatedHttpTopologyEntryUntilCompletionResult'
    ];
    readonly now?: () => number;
}

interface RecordingGateway {
    readonly gateway: ReturnType<typeof createApiAdminMutationGateway>;
    readonly crdtCalls: CrdtAdminMutationInput[];
}

interface CreateAppOptions {
    readonly adminClientIds?: adminOperationsRoutes.AdminOperationsRouteDependencies['adminClientIds'];
    readonly requireApiAuthSession?: adminOperationsRoutes.AdminOperationsRouteDependencies['requireApiAuthSession'];
    readonly requireApiAdminSession?: adminOperationsRoutes.AdminOperationsRouteDependencies['requireApiAdminSession'];
    readonly operations?: Partial<adminOperationsRoutes.AdminOperationsRouteService>;
}

function createRecordingGateway(
    input: CreateRecordingGatewayInput = {}
): RecordingGateway {
    const crdtCalls: CrdtAdminMutationInput[] = [];
    const gateway = createApiAdminMutationGateway({
        appAdmin: {
            pruneExpired: input.pruneExpired ?? (() => Promise.reject(new Error('Unexpected prune')))
        },
        crdtAdminMutations: {
            writeCrdtAdminMutation: (mutation) => {
                crdtCalls.push(mutation);
                return Promise.resolve(toRecordedCrdtResult(mutation));
            }
        },
        appGroup: {
            processAuthenticatedHttpTopologyEntryUntilCompletionResult: input.topology ??
                (() => Promise.reject(new Error('Unexpected topology recompute')))
        },
        now: input.now ?? (() => NOW_EPOCH_MS)
    });
    return { gateway, crdtCalls };
}

function toRecordedCrdtResult(mutation: CrdtAdminMutationInput): CrdtAdminPublicResult {
    switch (mutation.operation) {
        case 'rebuild-projection':
            return {
                valid: true,
                issues: [],
                documentKey: CRDT_METADATA.documentKey,
                checkedUpdateCount: 0,
                sequenceGaps: []
            };
        case 'compact':
            return {
                document: CRDT_DOCUMENT,
                documentKey: CRDT_METADATA.documentKey,
                appendSequence: 0,
                snapshot: {
                    protocolVersion: 1,
                    document: CRDT_DOCUMENT,
                    snapshotId: 'snapshot-1',
                    schemaVersion: 1,
                    createdAtEpochMs: NOW_EPOCH_MS,
                    maxLamport: 0,
                    includedUpdateIds: [],
                    value: null,
                    metadata: { updateCount: 0, reason: 'test' }
                }
            };
        case 'lifecycle':
            return CRDT_METADATA;
        case 'erase':
            return {
                request: {
                    document: CRDT_DOCUMENT,
                    requestedAtEpochMs: NOW_EPOCH_MS,
                    requestedBy: ADMIN_SESSION.clientId,
                    reason: 'test',
                    mode: 'destroy-document'
                },
                auditEvent: { kind: 'erase', atEpochMs: NOW_EPOCH_MS },
                metadata: CRDT_METADATA
            };
    }
}

function createApp(options: CreateAppOptions = {}): Hono {
    const app = new Hono();
    const { operations, ...routeOptions } = options;
    adminOperationsRoutes.registerAdminOperationsRoutes(app, {
        adminClientIds: ['platform-admin'],
        requireApiAuthSession: () => Promise.resolve(ADMIN_SESSION),
        operations: createOperations(operations),
        ...routeOptions
    });
    return app;
}

function createOperations(
    overrides: Partial<adminOperationsRoutes.AdminOperationsRouteService> = {}
): adminOperationsRoutes.AdminOperationsRouteService {
    const unusedOperation = () => Promise.reject(new Error('Admin operation is unused'));
    return {
        readOverview: () =>
            Promise.resolve({
                generatedAtEpochMs: NOW_EPOCH_MS,
                serverId: 'test-server',
                warnings: [],
                health: { status: 'ok' }
            }),
        readQueues: unusedOperation,
        readRealtime: unusedOperation,
        readState: unusedOperation,
        readCrdt: unusedOperation,
        readSystem: unusedOperation,
        resetMetrics: unusedOperation,
        recomputeTopology: unusedOperation,
        pruneExpired: unusedOperation,
        verifyCrdtIntegrity: unusedOperation,
        exportCrdtDebug: unusedOperation,
        compactCrdt: unusedOperation,
        updateCrdtLifecycle: unusedOperation,
        eraseCrdt: unusedOperation,
        ...overrides
    };
}
