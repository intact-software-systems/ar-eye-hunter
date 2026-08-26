import { describe, expect, it } from 'vitest';

import { decodeExactSnapshotEnvelope } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-snapshot-envelope.ts';
import { RALLAR_CRDT_PROTOCOL_VERSION, type RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'principal',
    documentType: 'checklist',
    documentId: 'document-1',
    principalId: 'principal-1'
};

describe('CRDT snapshot value decoding', () => {
    it('decodes the exact envelope through named snapshot-state operations', () => {
        const snapshot = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: DOCUMENT,
            snapshotId: 'snapshot-1',
            schemaVersion: 1,
            createdAtEpochMs: 2_000,
            maxLamport: 0,
            includedUpdateIds: [],
            value: {},
            metadata: { updateCount: 0 }
        };

        expect(decodeExactSnapshotEnvelope(snapshot)).toEqual(snapshot);
        expect(() =>
            decodeExactSnapshotEnvelope({
                ...snapshot,
                metadata: { updateCount: 0, unknownState: true }
            })
        ).toThrow(/snapshot metadata|fields|exact/i);
    });
});
