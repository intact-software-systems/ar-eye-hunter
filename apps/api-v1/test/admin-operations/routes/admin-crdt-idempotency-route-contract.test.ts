import assert from 'node:assert/strict';

import { Hono } from 'jsr:@hono/hono@4.11.9';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { RallarCrdtAdminReadRepository, RallarCrdtDocumentMetadata, RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

import type { AdminOperationMutationWriteInput } from '../../../src/admin-operations/register-admin-operation-mutation-routes.ts';
import { registerAdminOperationsRoutes, type AdminOperationsRouteService } from '../../../src/admin-operations/register-admin-operations-routes.ts';
import { registerCrdtAdminRoutes } from '../../../src/crdt/register-crdt-admin-routes.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const REQUEST_ID = 'request-000000000001';
const ADMIN_SESSION: IssuedAuthSession = {
    clientId: 'platform-admin',
    username: 'admin',
    accessToken: 'access-token',
    sessionId: 'admin-session',
    issuedAtEpochMs: NOW_EPOCH_MS,
    expiresAtEpochMs: NOW_EPOCH_MS + 60_000
};
const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'document-1'
};
const DOCUMENT_METADATA: RallarCrdtDocumentMetadata = {
    document: DOCUMENT,
    documentKey: 'app-1/workspace-1/room/checklist/document-1',
    documentRevision: 1,
    lifecycle: 'archived',
    createdAtEpochMs: NOW_EPOCH_MS,
    updatedAtEpochMs: NOW_EPOCH_MS,
    archivedAtEpochMs: NOW_EPOCH_MS,
    destroyedAtEpochMs: null,
    lastAppendSequence: 0,
    updateCount: 0,
    snapshotCount: 0,
    storedUpdateBytes: 0,
    retention: null,
    quota: null,
    projectionIds: []
};

interface MutationRouteCase {
    readonly path: string;
    readonly body: JsonWireObject;
    readonly operation: string;
    readonly family: 'admin' | 'crdt';
}

const ROUTES: readonly MutationRouteCase[] = [
    {
        path: '/api/admin/operations/topology/recompute',
        body: {
            groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' }
        },
        operation: 'topology-recompute',
        family: 'admin'
    },
    {
        path: '/api/admin/operations/maintenance/prune-expired',
        body: { categories: ['runtime-state'], dryRun: true },
        operation: 'prune-expired',
        family: 'admin'
    },
    {
        path: '/api/admin/operations/crdt/compact',
        body: { document: DOCUMENT, reason: 'operator' },
        operation: 'compact',
        family: 'admin'
    },
    {
        path: '/api/admin/operations/crdt/lifecycle',
        body: { document: DOCUMENT, lifecycle: 'archived' },
        operation: 'lifecycle',
        family: 'admin'
    },
    {
        path: '/api/admin/operations/crdt/erase',
        body: { document: DOCUMENT, mode: 'destroy-document' },
        operation: 'erase',
        family: 'admin'
    },
    {
        path: '/api/crdt/admin/documents/rebuild-projection',
        body: { document: DOCUMENT, projectionId: 'summary' },
        operation: 'rebuild-projection',
        family: 'crdt'
    },
    {
        path: '/api/crdt/admin/documents/compact',
        body: { document: DOCUMENT, reason: 'operator' },
        operation: 'compact',
        family: 'crdt'
    },
    {
        path: '/api/crdt/admin/documents/lifecycle',
        body: { document: DOCUMENT, lifecycle: 'archived' },
        operation: 'lifecycle',
        family: 'crdt'
    },
    {
        path: '/api/crdt/admin/documents/erase',
        body: { document: DOCUMENT, mode: 'destroy-document' },
        operation: 'erase',
        family: 'crdt'
    }
];

Deno.test(
    'all CRDT and admin AppInbox HTTP mutations use path-owned request identity',
    async () => {
        const fixture = createRouteFixture();

        for (const route of ROUTES) {
            const response = await postMutation(
                fixture.app,
                `${route.path}/requests/${REQUEST_ID}`,
                route.body
            );
            assert.equal(response.status, 200, route.path);
        }

        assert.deepEqual(
            fixture.calls.map(({ family, operation, requestId, request }) => ({
                family,
                operation,
                requestId,
                request
            })),
            ROUTES.map((route) => ({
                family: route.family,
                operation: route.operation,
                requestId: REQUEST_ID,
                request: route.body
            }))
        );
    }
);

Deno.test('all replaced CRDT and admin mutation URLs return 404', async () => {
    const fixture = createRouteFixture();

    for (const route of ROUTES) {
        const response = await postMutation(fixture.app, route.path, route.body);
        assert.equal(response.status, 404, route.path);
    }

    assert.deepEqual(fixture.calls, []);
});

Deno.test('all strict CRDT and admin mutation routes reject header request identity', async () => {
    for (const route of ROUTES) {
        const fixture = createRouteFixture();
        const response = await postMutation(
            fixture.app,
            `${route.path}/requests/${REQUEST_ID}`,
            route.body,
            { 'Idempotency-Key': REQUEST_ID }
        );

        await assertCanonicalValidationFailure(response, route.path);
        assert.equal(fixture.authCalls(), 1, route.path);
        assert.deepEqual(fixture.calls, []);
    }
});

Deno.test('all strict CRDT and admin mutation routes reject body request identity', async () => {
    for (const route of ROUTES) {
        const fixture = createRouteFixture();
        const response = await postMutation(fixture.app, `${route.path}/requests/${REQUEST_ID}`, {
            ...route.body,
            requestId: REQUEST_ID
        });

        await assertCanonicalValidationFailure(response, route.path);
        assert.equal(fixture.authCalls(), 1, route.path);
        assert.deepEqual(fixture.calls, []);
    }
});

Deno.test(
    'strict CRDT and admin mutation routes authenticate before request validation',
    async () => {
        for (const route of ROUTES) {
            const fixture = createRouteFixture({ authenticated: false });
            const response = await postMutation(
                fixture.app,
                `${route.path}/requests/short`,
                { ...route.body, requestId: REQUEST_ID },
                { 'Idempotency-Key': REQUEST_ID }
            );

            assert.equal(response.status, 401, route.path);
            const failure = await readJsonRecord(response);
            assert.equal(failure.type, 'api-mutation-failure', route.path);
            assert.equal(failure.version, 'canonical.v2', route.path);
            assert.equal(failure.code, 'api-authentication-required', route.path);
            assert.equal(fixture.authCalls(), 1, route.path);
            assert.deepEqual(fixture.calls, []);
        }
    }
);

Deno.test('all strict CRDT and admin routes enforce exact request ID boundaries', async () => {
    for (const route of ROUTES) {
        for (
            const [length, accepted] of [[19, false], [20, true], [128, true], [129, false]] as const
        ) {
            const fixture = createRouteFixture();
            const requestId = 'a'.repeat(length);
            const response = await postMutation(
                fixture.app,
                `${route.path}/requests/${requestId}`,
                route.body
            );
            if (accepted) {
                assert.equal(response.status, 200, `${route.path} length ${length}`);
                assert.equal(fixture.calls[0]?.requestId, requestId, route.path);
            }
            else {
                await assertCanonicalValidationFailure(response, `${route.path} length ${length}`);
                assert.deepEqual(fixture.calls, []);
            }
            assert.equal(fixture.authCalls(), 1, route.path);
        }
    }
});

interface RouteCall {
    readonly family: MutationRouteCase['family'];
    readonly operation: string;
    readonly requestId: string;
    readonly request: JsonWireValue;
}

interface RouteFixture {
    readonly app: Hono;
    readonly calls: readonly RouteCall[];
    readonly authCalls: () => number;
}

interface CreateRouteFixtureInput {
    readonly authenticated?: boolean;
}

function createRouteFixture(input: CreateRouteFixtureInput = {}): RouteFixture {
    const calls: RouteCall[] = [];
    let authCallCount = 0;
    const app = new Hono();
    const requireAdminSession = (): Promise<IssuedAuthSession> => {
        authCallCount += 1;
        return input.authenticated === false
            ? Promise.reject(Object.assign(new Error('Authentication required'), {
                code: 'api-authentication-required',
                status: 401
            }))
            : Promise.resolve(ADMIN_SESSION);
    };

    registerAdminOperationsRoutes(app, {
        adminClientIds: ['platform-admin'],
        requireApiAuthSession: async () => await requireAdminSession(),
        requireApiAdminSession: async () => await requireAdminSession(),
        operations: createAdminOperations(calls)
    });
    registerCrdtAdminRoutes(app, {
        repository: createUnusedCrdtReadRepository(),
        crdtAdminMutations: {
            writeCrdtAdminMutation: (mutation) => {
                calls.push({
                    family: 'crdt',
                    operation: mutation.operation,
                    requestId: mutation.requestId,
                    request: mutation.request
                });
                return Promise.resolve({
                    valid: true,
                    issues: [],
                    documentKey: 'app-1/workspace-1/room/checklist/document-1',
                    checkedUpdateCount: 0,
                    sequenceGaps: []
                });
            }
        },
        requireApiAdminSession: async () => await requireAdminSession(),
        requireApiUserSession: async () => await requireAdminSession(),
        adminClientIds: ['platform-admin']
    });
    return { app, calls, authCalls: () => authCallCount };
}

function createAdminOperations(calls: RouteCall[]): AdminOperationsRouteService {
    const unusedRead = () => Promise.reject(new Error('Admin read operation is unused'));
    const record = (operation: string, mutation: AdminOperationMutationWriteInput) => {
        calls.push({
            family: 'admin',
            operation,
            requestId: mutation.requestId,
            request: mutation.request
        });
    };
    return {
        readOverview: unusedRead,
        readQueues: unusedRead,
        readRealtime: unusedRead,
        readState: unusedRead,
        readCrdt: unusedRead,
        readSystem: unusedRead,
        resetMetrics: () => Promise.reject(new Error('Admin metrics reset is unused')),
        recomputeTopology: (mutation) => {
            record('topology-recompute', mutation);
            return Promise.resolve({
                status: 'queued',
                groupRef: mutation.request.groupRef,
                requestId: mutation.requestId,
                outboxId: 'topology-outbox-1'
            });
        },
        pruneExpired: (mutation) => {
            record('prune-expired', mutation);
            return Promise.resolve({
                generatedAtEpochMs: NOW_EPOCH_MS,
                serverId: 'server-1',
                warnings: [],
                operation: 'maintenance.prune-expired',
                status: 'dry-run',
                changed: false,
                jobId: 'prune-job-1',
                results: []
            });
        },
        verifyCrdtIntegrity: () => Promise.reject(new Error('CRDT integrity is unused')),
        exportCrdtDebug: () => Promise.reject(new Error('CRDT debug export is unused')),
        compactCrdt: (mutation) => {
            record('compact', mutation);
            return Promise.resolve({
                document: DOCUMENT,
                documentKey: DOCUMENT_METADATA.documentKey,
                appendSequence: 0,
                snapshot: {
                    protocolVersion: 1,
                    document: DOCUMENT,
                    snapshotId: 'snapshot-1',
                    schemaVersion: 1,
                    createdAtEpochMs: NOW_EPOCH_MS,
                    maxLamport: 0,
                    includedUpdateIds: [],
                    value: null,
                    metadata: { updateCount: 0, reason: 'test' }
                }
            });
        },
        updateCrdtLifecycle: (mutation) => {
            record('lifecycle', mutation);
            return Promise.resolve(DOCUMENT_METADATA);
        },
        eraseCrdt: (mutation) => {
            record('erase', mutation);
            return Promise.resolve({
                request: {
                    document: DOCUMENT,
                    requestedAtEpochMs: NOW_EPOCH_MS,
                    requestedBy: ADMIN_SESSION.clientId,
                    reason: 'test',
                    mode: 'destroy-document'
                },
                auditEvent: { kind: 'erase', atEpochMs: NOW_EPOCH_MS },
                metadata: DOCUMENT_METADATA
            });
        }
    };
}

function createUnusedCrdtReadRepository(): RallarCrdtAdminReadRepository {
    const unused = () => Promise.reject(new Error('CRDT read operation is unused'));
    return {
        listAfter: unused,
        readSnapshot: unused,
        readDocumentMetadata: unused,
        listDocuments: unused,
        exportDebugBundle: unused,
        exportBackupBundle: unused,
        verifyIntegrity: unused
    };
}

async function postMutation(
    app: Hono,
    path: string,
    body: JsonWireValue,
    headers: Readonly<Record<string, string>> = {}
): Promise<Response> {
    return await app.request(path, {
        method: 'POST',
        headers: {
            authorization: 'Bearer access-token',
            'x-client-id': ADMIN_SESSION.clientId,
            'content-type': 'application/json',
            ...headers
        },
        body: JSON.stringify(body)
    });
}

async function assertCanonicalValidationFailure(
    response: Response,
    path: string
): Promise<void> {
    assert.equal(response.status, 400, path);
    const failure = await readJsonRecord(response);
    assert.equal(failure.type, 'api-mutation-failure', path);
    assert.equal(failure.version, 'canonical.v2', path);
    assert.equal(failure.code, 'api-mutation-request-invalid', path);
    assert.equal(failure.status, 400, path);
}

async function readJsonRecord(response: Response): Promise<JsonWireObject> {
    const value = decodeJsonWireValue(await response.json(), 'HTTP response');
    if (!isJsonWireObject(value)) {
        throw new TypeError('HTTP response must be a JSON object');
    }
    return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
