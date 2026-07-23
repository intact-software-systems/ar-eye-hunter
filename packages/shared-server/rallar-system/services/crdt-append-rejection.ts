import type { RallarCrdtAppendRejectionCode } from '@shared/crdt/mod.ts';

export function toAppendRejectionCode(code: string): RallarCrdtAppendRejectionCode {
    const supported: readonly RallarCrdtAppendRejectionCode[] = [
        'authorization-denied', 'document-archived', 'document-destroyed',
        'document-quarantined', 'duplicate-hash-mismatch', 'feature-disabled',
        'invalid-update', 'quota-exceeded', 'rate-limited',
        'schema-version-not-allowed', 'update-too-large', 'storage-failed',
    ];
    return supported.includes(code as RallarCrdtAppendRejectionCode)
        ? code as RallarCrdtAppendRejectionCode
        : 'storage-failed';
}

export function appendRejectionReason(code: RallarCrdtAppendRejectionCode): string {
    return ({
        'authorization-denied': 'Current authority does not permit this CRDT append.',
        'document-archived': 'The CRDT document is archived.',
        'document-destroyed': 'The CRDT document is destroyed.',
        'document-quarantined': 'The CRDT document is quarantined.',
        'duplicate-hash-mismatch': 'The update ID is already bound to different content.',
        'feature-disabled': 'CRDT durable append is disabled by current policy.',
        'invalid-update': 'The CRDT update envelope is invalid.',
        'quota-exceeded': 'The CRDT document quota would be exceeded.',
        'rate-limited': 'The actor update rate limit was reached.',
        'schema-version-not-allowed': 'The CRDT schema version is not allowed.',
        'update-too-large': 'The CRDT update exceeds the configured size limit.',
        'storage-failed': 'The CRDT append could not be completed.',
    })[code];
}
