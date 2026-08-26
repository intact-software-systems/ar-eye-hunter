import { describe, expect, it } from 'vitest';

import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import { toRallarCrdtDocumentKey, type RallarCrdtDocumentMetadata, type RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'principal',
    documentType: 'checklist',
    documentId: 'document-1',
    principalId: 'principal-1'
};

describe('CRDT administration mutation result decoding', () => {
    it('keeps accepted lifecycle metadata bound to the outer revision and sequence', () => {
        const result = {
            version: 1,
            operation: 'lifecycle',
            status: 'accepted',
            commandId: 'lifecycle-1',
            documentKey: toRallarCrdtDocumentKey(DOCUMENT),
            documentRevision: 2,
            appendSequence: 1,
            code: null,
            metadata: documentMetadata()
        } as const;

        expect(decodeCrdtMutationResult(result)).toEqual(result);
        expect(() => decodeCrdtMutationResult({ ...result, documentRevision: 3 })).toThrow(
            /metadata|revision|sequence/i
        );
    });

    it('requires rejected lifecycle results to omit accepted metadata', () => {
        const result = {
            version: 1,
            operation: 'lifecycle',
            status: 'rejected',
            commandId: 'lifecycle-2',
            documentKey: toRallarCrdtDocumentKey(DOCUMENT),
            documentRevision: 1,
            appendSequence: null,
            code: 'authorization-denied',
            metadata: null
        } as const;

        expect(decodeCrdtMutationResult(result)).toEqual(result);
        expect(() => decodeCrdtMutationResult({ ...result, metadata: documentMetadata() })).toThrow(
            /status|payload|metadata/i
        );
    });
});

function documentMetadata(): RallarCrdtDocumentMetadata {
    return {
        document: DOCUMENT,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        documentRevision: 2,
        lifecycle: 'archived',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
        archivedAtEpochMs: 2_000,
        destroyedAtEpochMs: null,
        lastAppendSequence: 1,
        updateCount: 1,
        snapshotCount: 0,
        storedUpdateBytes: 0,
        retention: null,
        quota: null,
        projectionIds: []
    };
}
