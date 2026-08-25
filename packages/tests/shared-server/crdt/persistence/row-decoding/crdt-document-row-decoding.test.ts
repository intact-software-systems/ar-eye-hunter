import { describe, expect, it } from 'vitest';

import {
    decodeCrdtDocumentRow,
    type CrdtDocumentRow
} from '@shared-server/rallar-system/crdt/persistence/row-decoding/decode-crdt-document-row.ts';
import {
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentMetadata,
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

describe('CRDT document row decoding', () => {
    it('rejects impossible lifecycle timestamps at the corruption boundary', () => {
        expect(() =>
            decodeCrdtDocumentRow({
                row: documentRow({ lifecycle: 'archived', archived_at_ts: null }),
                expectedDocumentKey: toRallarCrdtDocumentKey(DOCUMENT),
                expectedDocument: DOCUMENT
            })
        ).toThrow(/document|metadata|lifecycle|corrupt/i);
    });

    it('rejects malformed current retention policy JSON without a fallback', () => {
        expect(() =>
            decodeCrdtDocumentRow({
                row: documentRow({ retention_policy: JSON.stringify({ mode: 'retain', extra: true }) }),
                expectedDocumentKey: toRallarCrdtDocumentKey(DOCUMENT),
                expectedDocument: DOCUMENT
            })
        ).toThrow(/retention|corrupt|fields/i);
    });
});

function documentRow(overrides: Partial<CrdtDocumentRow> = {}): CrdtDocumentRow {
    const value = metadata();
    return {
        document_key: value.documentKey,
        application_id: DOCUMENT.applicationId,
        workspace_id: DOCUMENT.workspaceId ?? null,
        document_scope: DOCUMENT.scope,
        document_type: DOCUMENT.documentType,
        document_id: DOCUMENT.documentId,
        document_ref: JSON.stringify(DOCUMENT),
        document_revision: value.documentRevision,
        lifecycle: value.lifecycle,
        created_at_ts: new Date(value.createdAtEpochMs),
        updated_at_ts: new Date(value.updatedAtEpochMs),
        archived_at_ts: null,
        destroyed_at_ts: null,
        last_append_sequence: value.lastAppendSequence,
        update_count: value.updateCount,
        snapshot_count: value.snapshotCount,
        stored_update_bytes: value.storedUpdateBytes,
        retention_policy: null,
        quota_policy: null,
        projection_ids: JSON.stringify([]),
        ...overrides
    };
}

function metadata(): RallarCrdtDocumentMetadata {
    return {
        document: DOCUMENT,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        documentRevision: 1,
        lifecycle: 'active',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 1_000,
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
}
