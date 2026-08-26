import { describe, expect, it } from 'vitest';

import { appendRejectionReason } from '@shared-server/rallar-system/crdt/mutation/crdt-append-rejection.ts';
import { decodeCrdtMutationResult } from '@shared-server/rallar-system/crdt/mutation/decode-crdt-mutation-result.ts';
import {
    hashRallarCrdtUpdateEnvelope,
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

const DOCUMENT: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    scope: 'principal',
    documentType: 'checklist',
    documentId: 'document-1',
    principalId: 'principal-1'
};

describe('CRDT append mutation result decoding', () => {
    it('keeps the mutation command identity independent from the accepted update identity', () => {
        const result = acceptedAppendResult();

        expect(decodeCrdtMutationResult(result)).toEqual(result);
        expect(
            decodeCrdtMutationResult({ ...result, commandId: 'independent-command-id' })
        ).toMatchObject({
            commandId: 'independent-command-id',
            appendResult: { update: { updateId: 'update-1' } }
        });
    });

    it('binds the outer rejection code to the nested append rejection', () => {
        const result = rejectedAppendResult();

        expect(decodeCrdtMutationResult(result)).toEqual(result);
        expect(() =>
            decodeCrdtMutationResult({
                ...result,
                code: 'quota-exceeded'
            })
        ).toThrow(/code|rejection|inconsistent/i);
    });
});

function acceptedAppendResult() {
    const update = updateEnvelope();
    return {
        version: 1,
        operation: 'append',
        status: 'accepted',
        commandId: update.updateId,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        documentRevision: 1,
        appendSequence: 1,
        code: null,
        appendResult: {
            status: 'accepted',
            update,
            append: {
                appendSequence: 1,
                acceptedAtEpochMs: 2_000,
                actorId: 'actor-1',
                principalId: 'principal-1',
                sessionId: 'session-1',
                serverId: 'server-1',
                authorizationScope: 'principal',
                acceptedUpdateHash: hashRallarCrdtUpdateEnvelope(update)
            },
            document: documentMetadata()
        }
    } as const;
}

function rejectedAppendResult() {
    const update = updateEnvelope();
    const code = 'authorization-denied' as const;
    return {
        version: 1,
        operation: 'append',
        status: 'rejected',
        commandId: update.updateId,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        documentRevision: null,
        appendSequence: null,
        code,
        appendResult: {
            status: 'rejected',
            update,
            code,
            reason: appendRejectionReason(code),
            retryable: false
        }
    } as const;
}

function updateEnvelope(): RallarCrdtUpdateEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document: DOCUMENT,
        updateId: 'update-1',
        replicaId: 'replica-1',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 1_000,
        payload: {
            kind: 'batch',
            operations: []
        }
    };
}

function documentMetadata(): RallarCrdtDocumentMetadata {
    return {
        document: DOCUMENT,
        documentKey: toRallarCrdtDocumentKey(DOCUMENT),
        documentRevision: 1,
        lifecycle: 'active',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
        archivedAtEpochMs: null,
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
