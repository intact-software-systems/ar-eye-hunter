import {
    requireExactKeys,
    requireOneOf,
    requireString
} from '../../protocol/exact-object-decoding.ts';
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../../protocol/json-wire-identity.ts';
import type {
    CrdtMutationCommand,
    CrdtMutationResult
} from './crdt-mutation-contracts.ts';
import { requireCrdtJsonWireObject } from './decoding/require-crdt-json-wire-object.ts';
import { decodeCrdtAppendMutationResult } from './result-decoding/decode-crdt-append-mutation-result.ts';
import { decodeCrdtCompactMutationResult } from './result-decoding/decode-crdt-compact-mutation-result.ts';
import { decodeCrdtEraseMutationResult } from './result-decoding/decode-crdt-erase-mutation-result.ts';
import { decodeCrdtLifecycleMutationResult } from './result-decoding/decode-crdt-lifecycle-mutation-result.ts';
import { decodeCrdtRebuildMutationResult } from './result-decoding/decode-crdt-rebuild-mutation-result.ts';

interface DecodedCrdtMutationResultEnvelopeBase {
    readonly version: 1;
    readonly operation: CrdtMutationCommand['operation'];
    readonly commandId: string;
    readonly documentKey: string;
}

export interface DecodedAcceptedCrdtMutationResultEnvelope
    extends DecodedCrdtMutationResultEnvelopeBase {
    readonly status: 'accepted';
    readonly documentRevision: number;
    readonly appendSequence: number;
    readonly code: null;
}

export interface DecodedReplayCrdtMutationResultEnvelope
    extends DecodedCrdtMutationResultEnvelopeBase {
    readonly operation: 'append';
    readonly status: 'replay';
    readonly documentRevision: number;
    readonly appendSequence: number;
    readonly code: null;
}

export interface DecodedRejectedCrdtMutationResultEnvelope
    extends DecodedCrdtMutationResultEnvelopeBase {
    readonly status: 'rejected';
    readonly documentRevision: number | null;
    readonly appendSequence: null;
    readonly code: string;
}

export type DecodedCrdtMutationResultEnvelope =
    | DecodedAcceptedCrdtMutationResultEnvelope
    | DecodedReplayCrdtMutationResultEnvelope
    | DecodedRejectedCrdtMutationResultEnvelope;

export function decodeCrdtMutationResult(value: unknown): CrdtMutationResult {
    const fields = requireCrdtJsonWireObject(
        decodeJsonWireValue(value, 'CRDT mutation result'),
        'CRDT mutation result'
    );
    const operation = requireOneOf(
        fields.operation,
        ['append', 'rebuild-projection', 'compact', 'lifecycle', 'erase'] as const,
        'result operation'
    );
    requireExactResultFields(fields, operation);
    const envelope = decodeResultEnvelope(fields, operation);
    switch (operation) {
        case 'append':
            return decodeCrdtAppendMutationResult({ fields, envelope });
        case 'compact':
            return decodeCrdtCompactMutationResult({ fields, envelope });
        case 'lifecycle':
            return decodeCrdtLifecycleMutationResult({ fields, envelope });
        case 'rebuild-projection':
            return decodeCrdtRebuildMutationResult({ fields, envelope });
        case 'erase':
            return decodeCrdtEraseMutationResult({ fields, envelope });
    }
}

function requireExactResultFields(
    fields: JsonWireObject,
    operation: CrdtMutationCommand['operation']
): void {
    const operationKeys = operation === 'append'
        ? ['appendResult']
        : operation === 'compact'
        ? ['snapshot', 'metadata']
        : operation === 'lifecycle'
        ? ['metadata']
        : operation === 'rebuild-projection'
        ? ['integrity', 'metadata']
        : ['request', 'auditEvent', 'metadata', 'redactedBundle'];
    requireExactKeys(
        fields,
        [
            'version',
            'operation',
            'status',
            'commandId',
            'documentKey',
            'documentRevision',
            'appendSequence',
            'code',
            ...operationKeys
        ],
        'CRDT mutation result'
    );
}

function decodeResultEnvelope(
    fields: JsonWireObject,
    operation: CrdtMutationCommand['operation']
): DecodedCrdtMutationResultEnvelope {
    if (fields.version !== 1) {
        throw new TypeError('CRDT mutation result version is invalid');
    }
    const status = requireOneOf(
        fields.status,
        ['accepted', 'replay', 'rejected'] as const,
        'result status'
    );
    if (status === 'replay' && operation !== 'append') {
        throw new TypeError('CRDT mutation replay status is valid only for append');
    }
    requireString(fields.commandId, 'result commandId');
    requireString(fields.documentKey, 'result documentKey');
    const documentRevision = decodeNullableNonNegativeInteger(
        fields.documentRevision,
        'result documentRevision'
    );
    const appendSequence = decodeNullableNonNegativeInteger(
        fields.appendSequence,
        'result appendSequence'
    );
    const code = decodeNullableString(fields.code, 'result code');
    const common = {
        version: 1 as const,
        operation,
        commandId: fields.commandId,
        documentKey: fields.documentKey
    };
    if (status === 'rejected') {
        if (appendSequence !== null || code === null) {
            throw new TypeError('CRDT rejected result sequence or code is inconsistent');
        }
        return {
            ...common,
            status,
            documentRevision,
            appendSequence: null,
            code
        };
    }
    if (documentRevision === null || appendSequence === null || code !== null) {
        throw new TypeError('CRDT accepted result revision, sequence, or code is inconsistent');
    }
    if (status === 'replay') {
        return {
            ...common,
            operation: 'append',
            status,
            documentRevision,
            appendSequence,
            code: null
        };
    }
    return {
        ...common,
        status,
        documentRevision,
        appendSequence,
        code: null
    };
}

function decodeNullableNonNegativeInteger(
    value: JsonWireValue | undefined,
    label: string
): number | null {
    if (value === null) {
        return null;
    }
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new TypeError(`${label} must be null or a non-negative safe integer`);
    }
    return Number(value);
}

function decodeNullableString(value: JsonWireValue | undefined, label: string): string | null {
    if (value === null) {
        return null;
    }
    requireString(value, label);
    return value;
}
