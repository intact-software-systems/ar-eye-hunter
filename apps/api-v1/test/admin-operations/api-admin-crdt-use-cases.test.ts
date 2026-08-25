import assert from 'node:assert/strict';

import type { RallarCrdtDocumentMetadata, RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

import { CompactApiAdminCrdt } from '../../src/admin-operations/compact-api-admin-crdt.ts';
import { EraseApiAdminCrdt } from '../../src/admin-operations/erase-api-admin-crdt.ts';
import { UpdateApiAdminCrdtLifecycle } from '../../src/admin-operations/update-api-admin-crdt-lifecycle.ts';
import type { CrdtAdminMutationInput, CrdtAdminPublicResult } from '../../src/crdt/create-crdt-admin-mutations.ts';

const NOW_EPOCH_MS = 1_700_000_000_000;
const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'room',
    documentType: 'map',
    documentId: 'doc-1'
};
const METADATA: RallarCrdtDocumentMetadata = {
    document: DOCUMENT,
    documentKey: 'app-1/workspace-1/room/map/doc-1',
    documentRevision: 1,
    lifecycle: 'active',
    createdAtEpochMs: NOW_EPOCH_MS,
    updatedAtEpochMs: NOW_EPOCH_MS,
    archivedAtEpochMs: null,
    destroyedAtEpochMs: null,
    lastAppendSequence: 0,
    updateCount: 0,
    snapshotCount: 0,
    storedUpdateBytes: 0,
    retention: null,
    quota: null,
    projectionIds: []
};

Deno.test('compact admin CRDT returns only a compact result', async () => {
    const calls: CrdtAdminMutationInput[] = [];
    const compact = new CompactApiAdminCrdt(createMutations(calls, {
        document: DOCUMENT,
        documentKey: METADATA.documentKey,
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
            metadata: { updateCount: 0, reason: 'operator' }
        }
    }));

    const result = await compact.execute(createRequest());

    assert.equal(result.snapshot.snapshotId, 'snapshot-1');
    assert.equal(calls[0]?.operation, 'compact');
});

Deno.test('lifecycle admin CRDT returns only document metadata', async () => {
    const calls: CrdtAdminMutationInput[] = [];
    const lifecycle = new UpdateApiAdminCrdtLifecycle(createMutations(calls, METADATA));

    const result = await lifecycle.execute(createRequest());

    assert.equal(result.documentKey, METADATA.documentKey);
    assert.equal(calls[0]?.operation, 'lifecycle');
});

Deno.test('erase admin CRDT returns only an erasure result', async () => {
    const calls: CrdtAdminMutationInput[] = [];
    const erase = new EraseApiAdminCrdt(createMutations(calls, {
        request: {
            document: DOCUMENT,
            requestedAtEpochMs: NOW_EPOCH_MS,
            requestedBy: 'platform-admin',
            reason: 'operator',
            mode: 'destroy-document'
        },
        auditEvent: { kind: 'erase', atEpochMs: NOW_EPOCH_MS },
        metadata: METADATA
    }));

    const result = await erase.execute(createRequest());

    assert.equal(result.auditEvent.kind, 'erase');
    assert.equal(calls[0]?.operation, 'erase');
});

function createMutations(
    calls: CrdtAdminMutationInput[],
    result: CrdtAdminPublicResult
) {
    return {
        writeCrdtAdminMutation: (input: CrdtAdminMutationInput) => {
            calls.push(input);
            return Promise.resolve(result);
        }
    };
}

function createRequest() {
    return {
        adminSession: {
            clientId: 'platform-admin',
            username: 'admin',
            accessToken: 'access-token',
            sessionId: 'admin-session',
            issuedAtEpochMs: NOW_EPOCH_MS - 1_000,
            expiresAtEpochMs: NOW_EPOCH_MS + 60_000
        },
        requestId: 'admin-crdt-request-0001',
        request: { document: DOCUMENT }
    };
}
