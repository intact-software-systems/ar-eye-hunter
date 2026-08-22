import { Hono } from 'jsr:@hono/hono@4.11.9';
import assert from 'node:assert/strict';

import {
    hashRallarCrdtUpdateEnvelope,
    InMemoryRallarCrdtAuditSink,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    rallarCrdtBatch,
    type RallarCrdtDocumentRef,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

import { InMemoryRallarCrdtLogRepository } from '@shared-server/rallar-system/crdt/persistence/in-memory-crdt-log-repository.ts';

import { registerCrdtAdminRoutes } from '../../../src/crdt/register-crdt-admin-routes.ts';

Deno.test('CRDT admin routes expose read-only repository health operations', async () => {
    const audit = new InMemoryRallarCrdtAuditSink();
    const repository = new InMemoryRallarCrdtLogRepository({
        now: () => 10_000,
        audit
    });
    const update = createCrdtUpdate('update-1');
    await repository.append({
        update,
        trusted: {
            authorizationScope: 'room',
            actorId: 'actor-a',
            principalId: 'principal-a',
            sessionId: 'session-a',
            serverId: 'server-a',
            acceptedAtEpochMs: 10_000
        }
    });

    const app = new Hono();
    registerCrdtAdminRoutes(app, {
        repository,
        crdtAdminMutations: {
            writeCrdtAdminMutation: () => Promise.reject(new Error('mutation not used'))
        },
        now: () => 12_000,
        requireAuth: false,
        requireApiAdminSession: () => Promise.reject(new Error('auth disabled')),
        requireApiUserSession: () => Promise.reject(new Error('auth disabled'))
    });

    const list = await postJson(app, '/api/crdt/admin/documents/list', {});
    assert.equal(list.ok, true);
    const documents = requireArray(list.result.documents, 'CRDT document list');
    assert.equal(documents.length, 1);
    assert.equal(requireRecord(documents[0], 'CRDT document status').updateCount, 1);

    const integrity = await postJson(app, '/api/crdt/admin/documents/integrity', {
        document: update.document
    });
    assert.equal(integrity.ok, true);
    assert.equal(integrity.result.valid, true);
    assert.equal(integrity.result.checkedUpdateCount, 1);

    const debug = await postJson(app, '/api/crdt/admin/documents/debug-export', {
        document: update.document,
        reason: 'test-export'
    });
    assert.equal(debug.ok, true);
    assert.equal(debug.result.format, 'rallar.crdt.debug-bundle.v1');
    const redaction = requireRecord(debug.result.redaction, 'CRDT debug redaction');
    assert.equal(redaction.payloadsRedacted, true);
    const records = requireArray(debug.result.records, 'CRDT debug records');
    const record = requireRecord(records[0], 'CRDT debug record');
    const recordUpdate = requireRecord(record.update, 'CRDT debug update');
    const payload = requireRecord(recordUpdate.payload, 'CRDT debug update payload');
    assert.deepEqual(payload.operations, []);
});

const CRDT_ROOM_REF = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1'
};

const CRDT_DOCUMENT_REF: RallarCrdtDocumentRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'room-1',
    roomRef: CRDT_ROOM_REF
};

function createCrdtUpdate(updateId: string): RallarCrdtUpdateEnvelope {
    const updateWithoutHash: RallarCrdtUpdateEnvelope = {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: CRDT_DOCUMENT_REF,
        updateId,
        replicaId: 'replica-a',
        actorId: 'actor-a',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 9_000,
        payload: rallarCrdtBatch([
            {
                kind: 'map.set',
                path: [],
                key: 'title',
                value: 'Admin route test'
            }
        ])
    };

    return {
        ...updateWithoutHash,
        hash: hashRallarCrdtUpdateEnvelope(updateWithoutHash)
    };
}

interface CrdtAdminRouteJson {
    readonly ok: boolean;
    readonly result: Record<string, unknown>;
}

async function postJson(
    app: Hono,
    path: string,
    body: unknown
): Promise<CrdtAdminRouteJson> {
    const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    const value: unknown = await response.json();
    const responseBody = requireRecord(value, 'CRDT admin response');
    if (typeof responseBody.ok !== 'boolean') {
        throw new TypeError('CRDT admin response ok must be a boolean');
    }
    return {
        ok: responseBody.ok,
        result: requireRecord(responseBody.result, 'CRDT admin response result')
    };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return Object.fromEntries(Object.entries(value));
}

function requireArray(value: unknown, label: string): readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    return value;
}
