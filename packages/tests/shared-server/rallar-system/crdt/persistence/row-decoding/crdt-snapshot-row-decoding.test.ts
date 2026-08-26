import { describe, expect, it } from 'vitest';

import { decodeCrdtSnapshotRow, type CrdtSnapshotRow } from '@shared-server/rallar-system/crdt/persistence/row-decoding/decode-crdt-snapshot-row.ts';
import { RALLAR_CRDT_PROTOCOL_VERSION, toRallarCrdtDocumentKey, type RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'principal',
    documentType: 'checklist',
    documentId: 'document-1',
    principalId: 'principal-1'
};

describe('CRDT snapshot row decoding', () => {
    it('rejects a persisted snapshot without the mandatory current reason', () => {
        const documentKey = toRallarCrdtDocumentKey(DOCUMENT);
        const snapshot = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: DOCUMENT,
            snapshotId: 'snapshot-without-reason',
            schemaVersion: 1,
            createdAtEpochMs: 2_000,
            maxLamport: 0,
            includedUpdateIds: [],
            value: {},
            metadata: { updateCount: 0 }
        };
        const row: CrdtSnapshotRow = {
            document_key: documentKey,
            snapshot_id: snapshot.snapshotId,
            append_sequence: 0,
            snapshot_envelope: JSON.stringify(snapshot),
            created_at_ts: new Date(snapshot.createdAtEpochMs),
            reason: 'row-reason',
            snapshot_bytes: 2,
            snapshot_count: 1
        };

        expect(() =>
            decodeCrdtSnapshotRow({
                row,
                expectedDocumentKey: documentKey,
                expectedDocument: DOCUMENT,
                lastAppendSequence: 0
            })
        ).toThrow(/snapshot|reason|corrupt/i);
    });
});
