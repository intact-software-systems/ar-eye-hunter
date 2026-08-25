import { describe, expect, it } from 'vitest';

import {
    decodeCrdtUpdateRow,
    type CrdtUpdateRow
} from '@shared-server/rallar-system/crdt/persistence/row-decoding/decode-crdt-update-row.ts';
import {
    hashRallarCrdtUpdateEnvelope,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentRef
} from '@shared/crdt/mod.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'principal',
    documentType: 'checklist',
    documentId: 'document-1',
    principalId: 'principal-1'
};

describe('CRDT update row decoding', () => {
    it('rejects an invalid physical sequence and authorization scope', () => {
        const update = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: DOCUMENT,
            updateId: 'update-1',
            replicaId: 'replica-1',
            lamport: 1,
            parents: [],
            schemaVersion: 1,
            operationVersion: RALLAR_CRDT_OPERATION_VERSION,
            createdAtEpochMs: 1_000,
            payload: { kind: 'batch' as const, operations: [] }
        };
        const row: CrdtUpdateRow = {
            document_key: toRallarCrdtDocumentKey(DOCUMENT),
            update_id: update.updateId,
            append_sequence: 0,
            update_envelope: JSON.stringify(update),
            accepted_update_hash: hashRallarCrdtUpdateEnvelope(update),
            actor_id: 'actor-1',
            principal_id: 'principal-1',
            session_id: 'session-1',
            server_id: 'server-1',
            authorization_scope: 'forged-scope',
            accepted_at_ts: new Date(1_000)
        };

        expect(() => decodeCrdtUpdateRow({ row, document: DOCUMENT })).toThrow(
            /update|sequence|scope|corrupt/i
        );
    });
});
