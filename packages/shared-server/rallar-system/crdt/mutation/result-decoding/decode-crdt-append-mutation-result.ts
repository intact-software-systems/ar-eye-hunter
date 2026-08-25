import {
    hashRallarCrdtUpdateEnvelope,
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtValidationResult
} from '@shared/crdt/mod.ts';

import {
    requireExactKeys,
    requireOneOf,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import type {
    JsonWireObject,
    JsonWireValue
} from '../../../protocol/json-wire-identity.ts';
import { appendRejectionReason, isAppendRejectionRetryable, toAppendRejectionCode } from '../crdt-append-rejection.ts';
import type { CrdtAppendMutationResult } from '../crdt-mutation-contracts.ts';
import type { DecodedCrdtMutationResultEnvelope } from '../decode-crdt-mutation-result.ts';
import { decodeExactDocumentMetadata } from '../decoding/decode-exact-document-metadata.ts';
import { decodeExactTrustedAppendMetadata } from '../decoding/decode-exact-trusted-append-metadata.ts';
import { requireCrdtJsonWireObject } from '../decoding/require-crdt-json-wire-object.ts';
import { decodeExactUpdateEnvelope } from '../decode-exact-update-envelope.ts';
import { decodeExactValidationResult } from './decode-exact-validation-result.ts';

export interface DecodeCrdtAppendMutationResultInput {
    readonly fields: JsonWireObject;
    readonly envelope: DecodedCrdtMutationResultEnvelope;
}

export function decodeCrdtAppendMutationResult(
    input: DecodeCrdtAppendMutationResultInput
): CrdtAppendMutationResult {
    const append = requireCrdtJsonWireObject(input.fields.appendResult, 'CRDT append result');
    const appendStatus = requireOneOf(
        append.status,
        ['accepted', 'duplicate', 'rejected'] as const,
        'append status'
    );
    const expectedStatus = input.envelope.status === 'accepted'
        ? 'accepted'
        : input.envelope.status === 'replay'
        ? 'duplicate'
        : 'rejected';
    if (appendStatus !== expectedStatus) {
        throw new TypeError('CRDT append result status is inconsistent');
    }
    if (appendStatus === 'rejected') {
        if (input.envelope.status !== 'rejected') {
            throw new TypeError('CRDT append result status is inconsistent');
        }
        return decodeRejectedAppendMutationResult(input.envelope, append);
    }
    if (input.envelope.status === 'rejected') {
        throw new TypeError('CRDT append result status is inconsistent');
    }
    return decodeAcceptedAppendMutationResult(input.envelope, append, appendStatus);
}

function decodeAcceptedAppendMutationResult(
    envelope: Exclude<DecodedCrdtMutationResultEnvelope, { status: 'rejected'; }>,
    fields: JsonWireObject,
    appendStatus: 'accepted' | 'duplicate'
): CrdtAppendMutationResult {
    requireExactKeys(fields, ['status', 'update', 'append', 'document'], 'CRDT append result');
    const update = decodeExactUpdateEnvelope(fields.update);
    const append = decodeExactTrustedAppendMetadata(
        requireResultValue(fields.append, 'CRDT append result metadata')
    );
    const document = decodeExactDocumentMetadata(
        requireResultValue(fields.document, 'CRDT append result document')
    );
    if (
        envelope.documentKey !== document.documentKey ||
        envelope.documentKey !== toRallarCrdtDocumentKey(update.document) ||
        envelope.documentRevision !== document.documentRevision ||
        envelope.appendSequence !== append.appendSequence ||
        document.lastAppendSequence < append.appendSequence ||
        append.acceptedUpdateHash !== hashRallarCrdtUpdateEnvelope(update)
    ) {
        throw new TypeError('CRDT append result document, revision, or sequence differs');
    }
    if (envelope.status === 'accepted' && appendStatus === 'accepted') {
        return {
            ...envelope,
            operation: 'append',
            status: envelope.status,
            appendResult: { status: 'accepted', update, append, document }
        };
    }
    if (envelope.status === 'replay' && appendStatus === 'duplicate') {
        return {
            ...envelope,
            operation: 'append',
            status: envelope.status,
            appendResult: { status: 'duplicate', update, append, document }
        };
    }
    throw new TypeError('CRDT append result status is inconsistent');
}

function decodeRejectedAppendMutationResult(
    envelope: Extract<DecodedCrdtMutationResultEnvelope, { status: 'rejected'; }>,
    fields: JsonWireObject
): CrdtAppendMutationResult {
    const keys = [
        'status',
        'update',
        'code',
        'reason',
        'retryable',
        ...('validation' in fields ? ['validation'] : []),
        ...('document' in fields ? ['document'] : [])
    ];
    requireExactKeys(fields, keys, 'CRDT append rejection');
    requireString(fields.code, 'append rejection code');
    requireString(fields.reason, 'append rejection reason');
    const code = toAppendRejectionCode(fields.code);
    if (code !== fields.code) {
        throw new TypeError('CRDT append rejection code is invalid');
    }
    if (toAppendRejectionCode(envelope.code) !== code) {
        throw new TypeError('CRDT append rejection code differs from outer result category');
    }
    if (appendRejectionReason(code) !== fields.reason) {
        throw new TypeError('CRDT append rejection reason differs from code');
    }
    if (typeof fields.retryable !== 'boolean') {
        throw new TypeError('CRDT append retryable is invalid');
    }
    const update = decodeExactUpdateEnvelope(fields.update);
    if (
        toRallarCrdtDocumentKey(update.document) !== envelope.documentKey
    ) {
        throw new TypeError('CRDT append rejection document differs');
    }
    const validation = decodeOptionalValidation(fields.validation);
    const document = decodeOptionalDocument(fields.document);
    if (
        (envelope.documentRevision === null) !== (document === undefined) ||
        (document !== undefined &&
            (document.documentKey !== envelope.documentKey ||
                document.documentRevision !== envelope.documentRevision))
    ) {
        throw new TypeError('CRDT append rejection document or revision differs');
    }
    const common = {
        status: 'rejected' as const,
        update,
        code,
        reason: fields.reason,
        ...(validation === undefined ? {} : { validation }),
        ...(document === undefined ? {} : { document })
    };
    if (isAppendRejectionRetryable(code)) {
        if (fields.retryable !== true) {
            throw new TypeError('CRDT append rejection retryable differs from code');
        }
        return {
            ...envelope,
            operation: 'append',
            appendResult: { ...common, code, retryable: true }
        };
    }
    if (fields.retryable !== false) {
        throw new TypeError('CRDT append rejection retryable differs from code');
    }
    return {
        ...envelope,
        operation: 'append',
        appendResult: { ...common, code, retryable: false }
    };
}

function decodeOptionalValidation(
    value: JsonWireValue | undefined
): RallarCrdtValidationResult | undefined {
    return value === undefined ? undefined : decodeExactValidationResult(value);
}

function decodeOptionalDocument(
    value: JsonWireValue | undefined
): RallarCrdtDocumentMetadata | undefined {
    return value === undefined ? undefined : decodeExactDocumentMetadata(value);
}

function requireResultValue(value: JsonWireValue | undefined, label: string): JsonWireValue {
    if (value === undefined) {
        throw new TypeError(`${label} is missing`);
    }
    return value;
}
