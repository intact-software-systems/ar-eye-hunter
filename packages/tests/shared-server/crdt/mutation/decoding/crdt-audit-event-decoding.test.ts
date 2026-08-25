import { describe, expect, it } from 'vitest';

import { decodeCrdtAuditEvent } from '@shared-server/rallar-system/crdt/mutation/decoding/decode-crdt-audit-event.ts';
import {
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

describe('CRDT audit event decoding', () => {
    it('owns the audit event boundary independently from admin request decoding', () => {
        const event = {
            kind: 'erase',
            atEpochMs: 2_000,
            documentKey: toRallarCrdtDocumentKey(DOCUMENT),
            principalId: 'principal-1',
            reason: 'privacy',
            metadata: { mode: 'destroy-document', attempts: 2, verified: true }
        } as const;

        expect(decodeCrdtAuditEvent(event)).toEqual(event);
        expect(() => decodeCrdtAuditEvent({ ...event, metadata: { mode: { nested: true } } })).toThrow(
            'CRDT audit outbox event is invalid'
        );
        expect(() => decodeCrdtAuditEvent(null)).toThrow(
            'CRDT audit outbox event must be an exact object'
        );
    });
});
