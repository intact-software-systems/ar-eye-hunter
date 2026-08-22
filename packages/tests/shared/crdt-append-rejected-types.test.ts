import { describe, expect, it } from 'vitest';
import {
    RALLAR_CRDT_OPERATION_VERSION,
    RALLAR_CRDT_PROTOCOL_VERSION,
    toRallarCrdtAppendRejectionCategory,
    type RallarCrdtAppendRejected,
    type RallarCrdtAppendRejectionCode,
    type RallarCrdtDocumentRef,
    type RallarCrdtHardeningErrorCategory,
    type RallarCrdtUpdateEnvelope
} from '../../shared/crdt/mod.ts';

type RallarCrdtRetryableCodeFromPublicUnion = Extract<RallarCrdtAppendRejected, { readonly retryable: true; }>['code'];

type AppendRejectionExpectationByCode = Readonly<
    {
        [Code in RallarCrdtAppendRejectionCode]: Readonly<{
            retryable: Code extends RallarCrdtRetryableCodeFromPublicUnion ? true :
                false;
            category: RallarCrdtHardeningErrorCategory;
        }>;
    }
>;

const APPEND_REJECTION_EXPECTATIONS = {
    'authorization-denied': {
        retryable: false,
        category: 'permanent.authorization'
    },
    'document-archived': {
        retryable: false,
        category: 'permanent.authorization'
    },
    'document-destroyed': {
        retryable: false,
        category: 'permanent.authorization'
    },
    'document-quarantined': {
        retryable: false,
        category: 'permanent.authorization'
    },
    'duplicate-hash-mismatch': {
        retryable: false,
        category: 'permanent.validation'
    },
    'feature-disabled': {
        retryable: false,
        category: 'permanent.authorization'
    },
    'invalid-update': {
        retryable: false,
        category: 'permanent.validation'
    },
    'quota-exceeded': {
        retryable: false,
        category: 'permanent.quota'
    },
    'rate-limited': {
        retryable: true,
        category: 'retryable.server'
    },
    'schema-version-not-allowed': {
        retryable: false,
        category: 'permanent.validation'
    },
    'update-too-large': {
        retryable: false,
        category: 'permanent.quota'
    },
    'storage-failed': {
        retryable: true,
        category: 'retryable.server'
    }
} as const satisfies AppendRejectionExpectationByCode;

const update = createUpdate();
const storageRejected = {
    status: 'rejected',
    update,
    code: 'storage-failed',
    reason: 'Storage failed.',
    retryable: true
} satisfies RallarCrdtAppendRejected;
const rateRejected = {
    status: 'rejected',
    update,
    code: 'rate-limited',
    reason: 'Rate limited.',
    retryable: true
} satisfies RallarCrdtAppendRejected;
const authorizationRejected = {
    status: 'rejected',
    update,
    code: 'authorization-denied',
    reason: 'Authorization denied.',
    retryable: false
} satisfies RallarCrdtAppendRejected;

const quotaRetryable = {
    status: 'rejected',
    update,
    code: 'quota-exceeded',
    reason: 'Quota exceeded.',
    retryable: true
} as const;
// @ts-expect-error quota rejection is never retryable
const invalidQuotaRetryability: RallarCrdtAppendRejected = quotaRetryable;

const missingUpdate = {
    status: 'rejected',
    code: 'authorization-denied',
    reason: 'Authorization denied.',
    retryable: false
} as const;
// @ts-expect-error every rejection carries the rejected update
const invalidMissingUpdate: RallarCrdtAppendRejected = missingUpdate;

const storageNonRetryable = {
    status: 'rejected',
    update,
    code: 'storage-failed',
    reason: 'Storage failed.',
    retryable: false
} as const;
// @ts-expect-error storage rejection is always retryable
const invalidStorageRetryability: RallarCrdtAppendRejected = storageNonRetryable;

describe('RallarCrdtAppendRejected type contract', () => {
    it('classifies every rejection consistently with exact retryability', () => {
        const codes = Object.keys(
            APPEND_REJECTION_EXPECTATIONS
        ) as RallarCrdtAppendRejectionCode[];

        for (const code of codes) {
            const expectation = APPEND_REJECTION_EXPECTATIONS[code];
            const category = toRallarCrdtAppendRejectionCategory(code);

            expect(category).toBe(expectation.category);
            expect(category.startsWith('retryable.')).toBe(
                expectation.retryable
            );
        }
    });

    it('carries the exact retryability discriminant and mandatory update', () => {
        expect([
            storageRejected.retryable,
            rateRejected.retryable,
            authorizationRejected.retryable
        ]).toEqual([true, true, false]);
        expect([
            invalidQuotaRetryability,
            invalidMissingUpdate,
            invalidStorageRetryability
        ]).toHaveLength(3);
    });
});

function createUpdate(): RallarCrdtUpdateEnvelope {
    const document: RallarCrdtDocumentRef = {
        applicationId: 'app-1',
        scope: 'app',
        documentType: 'checklist',
        documentId: 'document-1'
    };
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        document,
        updateId: 'update-1',
        replicaId: 'replica-1',
        lamport: 1,
        parents: [],
        schemaVersion: 1,
        operationVersion: RALLAR_CRDT_OPERATION_VERSION,
        createdAtEpochMs: 1,
        payload: {
            kind: 'batch',
            operations: [{
                kind: 'register.set',
                path: ['title'],
                policy: 'lww',
                value: 'one'
            }]
        }
    };
}
