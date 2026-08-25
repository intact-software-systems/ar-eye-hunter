import { describe, expect, it } from 'vitest';

import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { decodeExactDocumentMetadata } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-document-metadata.ts';
import { decodeExactDocumentRef } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-document-ref.ts';
import { decodeExactProjectionIds } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-projection-ids.ts';
import { decodeExactQuotaPolicy } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-quota-policy.ts';
import { decodeExactRetentionPolicy } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-retention-policy.ts';
import { decodeExactTrustedAppendMetadata } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-exact-trusted-append-metadata.ts';
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

describe('CRDT document value decoding', () => {
    it('decodes document identity without accepting scope-specific surplus fields', () => {
        expect(decodeExactDocumentRef(DOCUMENT)).toEqual(DOCUMENT);
        expect(() => decodeExactDocumentRef({ ...DOCUMENT, groupId: 'group-1' })).toThrow(/fields|exact/i);
    });

    it('keeps retention, quota, and projection policy validation independently callable', () => {
        expect(decodeExactRetentionPolicy({ mode: 'delete-after', ttlMs: 60_000 })).toEqual({
            mode: 'delete-after',
            ttlMs: 60_000
        });
        expect(() => decodeExactRetentionPolicy({ mode: 'delete-after' })).toThrow(/ttlMs/i);

        expect(decodeExactQuotaPolicy({ maxDocumentBytes: 4_096 })).toEqual({ maxDocumentBytes: 4_096 });
        expect(() => decodeExactQuotaPolicy({})).toThrow(/set a limit/i);

        expect(decodeExactProjectionIds(['search', 'timeline'])).toEqual(['search', 'timeline']);
        expect(() => decodeExactProjectionIds(['search', 'search'])).toThrow(/unique/i);
    });

    it('checks trusted append metadata as its own persisted boundary', () => {
        const metadata = {
            appendSequence: 1,
            acceptedAtEpochMs: 2_000,
            actorId: 'actor-1',
            principalId: 'principal-1',
            sessionId: 'session-1',
            serverId: 'server-1',
            authorizationScope: 'principal',
            acceptedUpdateHash: 'hash-1'
        } as const;

        expect(decodeExactTrustedAppendMetadata(metadata)).toEqual(metadata);
        expect(() => decodeExactTrustedAppendMetadata({ ...metadata, appendSequence: 0 })).toThrow(
            /append sequence/i
        );
    });

    it('binds document metadata identity, lifecycle, counters, and nested policies', () => {
        const metadata = documentMetadata();
        const wireMetadata = decodeJsonWireValue(metadata, 'CRDT document metadata fixture');

        expect(decodeExactDocumentMetadata(wireMetadata)).toEqual(metadata);
        expect(() =>
            decodeExactDocumentMetadata(
                decodeJsonWireValue(
                    {
                        ...metadata,
                        documentKey: 'different-document',
                        retention: { mode: 'retain', unexpected: true }
                    },
                    'invalid CRDT document metadata fixture'
                )
            )
        ).toThrow(/document key|retention/i);
    });
});

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
        lastAppendSequence: 0,
        updateCount: 0,
        snapshotCount: 0,
        storedUpdateBytes: 0,
        retention: { mode: 'retain' },
        quota: { maxDocumentBytes: 4_096 },
        projectionIds: ['search']
    };
}
