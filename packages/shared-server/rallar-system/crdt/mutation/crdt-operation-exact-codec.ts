import { requireExactKeys, requireExactOptionalKeys, requireRecord } from '../../services/exact-object-codec.ts';

export function decodeExactOperationBatchShape(value: unknown): void {
    const batch = requireRecord(value, 'CRDT operation batch');
    requireExactOptionalKeys(
        batch,
        ['kind', 'operations'],
        ['operationGroupId', 'undo', 'redo', 'encryption'],
        'CRDT operation batch'
    );
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

export function decodeExactCausalFrontierShape(value: unknown): void {
    const frontier = requireRecord(value, 'CRDT causal frontier');
    requireExactOptionalKeys(
        frontier,
        ['frontierUpdateIds'],
        ['replicaClocks'],
        'CRDT causal frontier'
    );
    if ('replicaClocks' in frontier) {
        decodeDynamicNumberRecord(frontier.replicaClocks, 'replica clocks');
    }
}

function decodeExactOperationShape(value: unknown): void {
    const operation = requireRecord(value, 'CRDT operation');
    const keys = operationKeys[operation.kind as keyof typeof operationKeys];
    if (!keys) {
        throw new TypeError('CRDT operation kind is invalid');
    }
    requireExactKeys(operation, keys, 'CRDT operation');
}

function decodeExactUndoRedoShape(value: unknown, label: string): void {
    const metadata = requireRecord(value, `CRDT ${label} metadata`);
    requireExactKeys(
        metadata,
        ['actorId', 'targetOperationGroupId', 'targetUpdateIds'],
        `CRDT ${label} metadata`
    );
}

export function decodeExactEncryptedEnvelopeShape(value: unknown): void {
    const envelope = requireRecord(value, 'CRDT encrypted envelope');
    requireExactOptionalKeys(
        envelope,
        [
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
        ['visibleMetadataFields'],
        'CRDT encrypted envelope'
    );
}

function decodeDynamicNumberRecord(value: unknown, label: string): void {
    const record = requireRecord(value, label);
    if (Object.values(record).some((item) => !Number.isSafeInteger(item) || (item as number) < 0)) {
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
