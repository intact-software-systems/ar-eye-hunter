import {
    requireEpoch,
    requireExactKeys,
    requireExactOptionalKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '../../services/exact-object-codec.ts';

export function decodeExactSnapshotClock(value: unknown): void {
    const clock = requireRecord(value, 'CRDT snapshot clock');
    requireExactKeys(clock, ['maxLamport', 'replicaClocks'], 'CRDT snapshot clock');
    requireEpoch(clock.maxLamport, 'snapshot clock maxLamport');
    const replicaClocks = requireRecord(clock.replicaClocks, 'snapshot replica clocks');
    for (const [replicaId, lamport] of Object.entries(replicaClocks)) {
        requireString(replicaId, 'snapshot clock replicaId');
        requireEpoch(lamport, `snapshot clock ${replicaId}`);
    }
}

export function decodeExactCrdtStateSnapshot(value: unknown): void {
    const state = requireRecord(value, 'CRDT state snapshot');
    requireExactOptionalKeys(
        state,
        ['format', 'registers', 'sets', 'maps', 'sequences'],
        ['counters', 'numbers'],
        'CRDT state snapshot'
    );
    if (state.format !== 'rallar.crdt.state.v1') {
        throw new TypeError('CRDT state snapshot format is invalid');
    }
    decodeDynamicSection(state.registers, 'registers', (entry) => {
        requireExactKeys(entry, ['path', 'writes'], 'CRDT register snapshot');
        decodePath(entry.path);
        decodeArray(entry.writes, (write) => decodeWrite(write, ['policy', 'value']));
    });
    decodeDynamicSection(state.sets, 'sets', (entry) => {
        requireExactKeys(entry, ['path', 'elements'], 'CRDT set snapshot');
        decodePath(entry.path);
        decodeArray(entry.elements, (element) => {
            requireExactKeys(element, ['elementId', 'adds', 'removes'], 'CRDT set element');
            requireString(element.elementId, 'CRDT set elementId');
            decodeArray(element.adds, (write) => decodeWrite(write, ['elementId', 'value']));
            decodeStringArray(element.removes, 'CRDT set removes');
        });
    });
    decodeDynamicSection(state.maps, 'maps', (entry) => {
        requireExactKeys(entry, ['path', 'entries'], 'CRDT map snapshot');
        decodePath(entry.path);
        decodeArray(entry.entries, (mapEntry) => {
            requireExactKeys(mapEntry, ['key', 'sets', 'deletes'], 'CRDT map entry');
            requireString(mapEntry.key, 'CRDT map key');
            decodeArray(mapEntry.sets, (write) => decodeWrite(write, ['key', 'value']));
            decodeStringArray(mapEntry.deletes, 'CRDT map deletes');
        });
    });
    decodeExactSequenceState(state.sequences);
    if ('counters' in state) {
        decodeDynamicSection(state.counters, 'counters', (entry) => {
            requireExactKeys(entry, ['path', 'adds'], 'CRDT counter snapshot');
            decodePath(entry.path);
            decodeArray(entry.adds, (write) => decodeWrite(write, ['delta']));
        });
    }
    if ('numbers' in state) {
        decodeDynamicSection(state.numbers, 'numbers', (entry) => {
            requireExactKeys(entry, ['path', 'writes'], 'CRDT number snapshot');
            decodePath(entry.path);
            decodeArray(entry.writes, (write) => {
                decodeWrite(write, ['merge', 'value']);
                requireOneOf(write.merge, ['min', 'max'] as const, 'CRDT number merge');
            });
        });
    }
}

export function decodeExactSequenceState(value: unknown): void {
    decodeDynamicSection(value, 'sequences', (entry) => {
        requireExactKeys(entry, ['path', 'entries'], 'CRDT sequence snapshot');
        decodePath(entry.path);
        decodeArray(entry.entries, (item) => {
            requireExactKeys(
                item,
                [
                    'elementId',
                    'positionId',
                    'value',
                    'insertUpdateId',
                    'positionUpdateId',
                    'replicaId',
                    'lamport',
                    'createdAtEpochMs'
                ],
                'CRDT sequence entry'
            );
            for (
                const field of [
                    'elementId',
                    'positionId',
                    'insertUpdateId',
                    'positionUpdateId',
                    'replicaId'
                ]
            ) {
                requireString(item[field], `CRDT sequence ${field}`);
            }
            requireEpoch(item.lamport, 'CRDT sequence lamport');
            requireEpoch(item.createdAtEpochMs, 'CRDT sequence createdAtEpochMs');
        });
    });
}

function decodeWrite(value: Record<string, unknown>, extraKeys: readonly string[]): void {
    requireExactKeys(
        value,
        ['updateId', 'replicaId', 'lamport', 'createdAtEpochMs', 'parents', ...extraKeys],
        'CRDT state write'
    );
    requireString(value.updateId, 'CRDT state write updateId');
    requireString(value.replicaId, 'CRDT state write replicaId');
    requireEpoch(value.lamport, 'CRDT state write lamport');
    requireEpoch(value.createdAtEpochMs, 'CRDT state write createdAtEpochMs');
    decodeStringArray(value.parents, 'CRDT state write parents');
}

function decodeDynamicSection(
    value: unknown,
    label: string,
    decode: (entry: Record<string, unknown>) => void
): void {
    const section = requireRecord(value, `CRDT ${label} section`);
    for (const entry of Object.values(section)) {
        decode(requireRecord(entry, `CRDT ${label} entry`));
    }
}

function decodeArray(value: unknown, decode: (entry: Record<string, unknown>) => void): void {
    if (!Array.isArray(value)) {
        throw new TypeError('CRDT snapshot list is invalid');
    }
    for (const entry of value) {
        decode(requireRecord(entry, 'CRDT snapshot list entry'));
    }
}

function decodePath(value: unknown): void {
    if (!Array.isArray(value) || value.some((part) => typeof part !== 'string')) {
        throw new TypeError('CRDT snapshot path is invalid');
    }
}

function decodeStringArray(value: unknown, label: string): void {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
        throw new TypeError(`${label} is invalid`);
    }
}
