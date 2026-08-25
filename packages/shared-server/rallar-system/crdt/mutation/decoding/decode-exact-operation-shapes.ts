import {
    requireExactKeys,
    requireExactOptionalKeys
} from '../../../protocol/exact-object-decoding.ts';
import type {
    JsonWireObject,
    JsonWireValue
} from '../../../protocol/json-wire-identity.ts';
import { requireCrdtJsonWireObject } from './require-crdt-json-wire-object.ts';

export function decodeExactOperationBatchShape(value: JsonWireValue): void {
    const batch = requireCrdtJsonWireObject(value, 'CRDT operation batch');
    requireExactOptionalKeys({
        value: batch,
        required: ['kind', 'operations'],
        optional: ['operationGroupId', 'undo', 'redo', 'encryption'],
        label: 'CRDT operation batch'
    });
    if (!Array.isArray(batch.operations)) {
        return;
    }
    for (const operation of batch.operations) {
        decodeExactOperationShape(operation);
    }
    if ('undo' in batch) {
        decodeExactUndoRedoShape(batch.undo, 'undo');
    }
    if ('redo' in batch) {
        decodeExactUndoRedoShape(batch.redo, 'redo');
    }
    if ('encryption' in batch) {
        decodeExactEncryptedEnvelopeShape(batch.encryption);
    }
}

export function decodeExactCausalFrontierShape(value: JsonWireValue): void {
    const frontier = requireCrdtJsonWireObject(value, 'CRDT causal frontier');
    requireExactOptionalKeys({
        value: frontier,
        required: ['frontierUpdateIds'],
        optional: ['replicaClocks'],
        label: 'CRDT causal frontier'
    });
    if ('replicaClocks' in frontier) {
        decodeDynamicNumberRecord(frontier.replicaClocks, 'replica clocks');
    }
}

export function decodeExactEncryptedEnvelopeShape(value: JsonWireValue): void {
    const envelope = requireCrdtJsonWireObject(value, 'CRDT encrypted envelope');
    requireExactOptionalKeys({
        value: envelope,
        required: [
            'kind',
            'format',
            'algorithm',
            'keyId',
            'nonce',
            'ciphertext',
            'plaintextHash',
            'aadHash',
            'plaintextType',
            'encryptedAtEpochMs'
        ],
        optional: ['visibleMetadataFields'],
        label: 'CRDT encrypted envelope'
    });
}

function decodeExactOperationShape(value: JsonWireValue): void {
    const operation = requireCrdtJsonWireObject(value, 'CRDT operation');
    const keys = operationKeys[operation.kind as keyof typeof operationKeys];
    if (!keys) {
        throw new TypeError('CRDT operation kind is invalid');
    }
    requireExactKeys(operation, keys, 'CRDT operation');
}

function decodeExactUndoRedoShape(value: JsonWireValue | undefined, label: string): void {
    const metadata = requireCrdtJsonWireObject(value, `CRDT ${label} metadata`);
    requireExactKeys(
        metadata,
        ['actorId', 'targetOperationGroupId', 'targetUpdateIds'],
        `CRDT ${label} metadata`
    );
}

function decodeDynamicNumberRecord(value: JsonWireValue | undefined, label: string): void {
    const record: JsonWireObject = requireCrdtJsonWireObject(value, label);
    if (Object.values(record).some((item) => !Number.isSafeInteger(item) || Number(item) < 0)) {
        throw new TypeError(`${label} values are invalid`);
    }
}

const operationKeys = {
    'orset.add': ['kind', 'path', 'elementId', 'value'],
    'orset.remove': ['kind', 'path', 'elementId', 'observedAddUpdateIds'],
    'register.set': ['kind', 'path', 'value', 'policy'],
    'map.set': ['kind', 'path', 'key', 'value'],
    'map.delete': ['kind', 'path', 'key', 'observedUpdateIds'],
    'sequence.insert': ['kind', 'path', 'elementId', 'positionId', 'value'],
    'sequence.delete': ['kind', 'path', 'elementId', 'observedUpdateIds'],
    'sequence.move': ['kind', 'path', 'elementId', 'positionId', 'observedUpdateIds'],
    'counter.add': ['kind', 'path', 'delta'],
    'number.min': ['kind', 'path', 'value'],
    'number.max': ['kind', 'path', 'value']
} as const;
