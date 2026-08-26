import {
    requireEpoch,
    requireExactKeys,
    requireExactOptionalKeys,
    requireOneOf,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { requireCrdtJsonWireObject } from './require-crdt-json-wire-object.ts';

export function decodeExactSnapshotClock(value: JsonWireValue): void {
    const clock = requireCrdtJsonWireObject(value, 'CRDT snapshot clock');
    requireExactKeys(clock, ['maxLamport', 'replicaClocks'], 'CRDT snapshot clock');
    requireEpoch(clock.maxLamport, 'snapshot clock maxLamport');
    const replicaClocks = requireCrdtJsonWireObject(
        clock.replicaClocks,
        'snapshot replica clocks'
    );
    for (const [replicaId, lamport] of Object.entries(replicaClocks)) {
        requireString(replicaId, 'snapshot clock replicaId');
        requireEpoch(lamport, `snapshot clock ${replicaId}`);
    }
}

export function decodeExactCrdtStateSnapshot(value: JsonWireValue): void {
    const state = requireCrdtJsonWireObject(value, 'CRDT state snapshot');
    requireExactOptionalKeys({
        value: state,
        required: ['format', 'registers', 'sets', 'maps', 'sequences'],
        optional: ['counters', 'numbers'],
        label: 'CRDT state snapshot'
    });
    if (state.format !== 'rallar.crdt.state.v1') {
        throw new TypeError('CRDT state snapshot format is invalid');
    }
    decodeRegisterSection(state.registers);
    decodeSetSection(state.sets);
    decodeMapSection(state.maps);
    decodeExactSequenceState(state.sequences);
    if ('counters' in state) {
        decodeCounterSection(state.counters);
    }
    if ('numbers' in state) {
        decodeNumberSection(state.numbers);
    }
}

export function decodeExactSequenceState(value: JsonWireValue): void {
    const section = requireCrdtJsonWireObject(value, 'CRDT sequences section');
    for (const entryValue of Object.values(section)) {
        const entry = requireCrdtJsonWireObject(entryValue, 'CRDT sequences entry');
        requireExactKeys(entry, ['path', 'entries'], 'CRDT sequence snapshot');
        decodePath(entry.path);
        for (const item of requireJsonWireObjectArray(entry.entries, 'CRDT sequence entries')) {
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
                ] as const
            ) {
                requireString(item[field], `CRDT sequence ${field}`);
            }
            requireEpoch(item.lamport, 'CRDT sequence lamport');
            requireEpoch(item.createdAtEpochMs, 'CRDT sequence createdAtEpochMs');
        }
    }
}

function decodeRegisterSection(value: JsonWireValue | undefined): void {
    const section = requireCrdtJsonWireObject(value, 'CRDT registers section');
    for (const entryValue of Object.values(section)) {
        const entry = requireCrdtJsonWireObject(entryValue, 'CRDT registers entry');
        requireExactKeys(entry, ['path', 'writes'], 'CRDT register snapshot');
        decodePath(entry.path);
        for (const write of requireJsonWireObjectArray(entry.writes, 'CRDT register writes')) {
            decodeWrite(write, ['policy', 'value']);
        }
    }
}

function decodeSetSection(value: JsonWireValue | undefined): void {
    const section = requireCrdtJsonWireObject(value, 'CRDT sets section');
    for (const entryValue of Object.values(section)) {
        const entry = requireCrdtJsonWireObject(entryValue, 'CRDT sets entry');
        requireExactKeys(entry, ['path', 'elements'], 'CRDT set snapshot');
        decodePath(entry.path);
        for (const element of requireJsonWireObjectArray(entry.elements, 'CRDT set elements')) {
            requireExactKeys(element, ['elementId', 'adds', 'removes'], 'CRDT set element');
            requireString(element.elementId, 'CRDT set elementId');
            for (const write of requireJsonWireObjectArray(element.adds, 'CRDT set adds')) {
                decodeWrite(write, ['elementId', 'value']);
            }
            decodeStringArray(element.removes, 'CRDT set removes');
        }
    }
}

function decodeMapSection(value: JsonWireValue | undefined): void {
    const section = requireCrdtJsonWireObject(value, 'CRDT maps section');
    for (const entryValue of Object.values(section)) {
        const entry = requireCrdtJsonWireObject(entryValue, 'CRDT maps entry');
        requireExactKeys(entry, ['path', 'entries'], 'CRDT map snapshot');
        decodePath(entry.path);
        for (const mapEntry of requireJsonWireObjectArray(entry.entries, 'CRDT map entries')) {
            requireExactKeys(mapEntry, ['key', 'sets', 'deletes'], 'CRDT map entry');
            requireString(mapEntry.key, 'CRDT map key');
            for (const write of requireJsonWireObjectArray(mapEntry.sets, 'CRDT map sets')) {
                decodeWrite(write, ['key', 'value']);
            }
            decodeStringArray(mapEntry.deletes, 'CRDT map deletes');
        }
    }
}

function decodeCounterSection(value: JsonWireValue | undefined): void {
    const section = requireCrdtJsonWireObject(value, 'CRDT counters section');
    for (const entryValue of Object.values(section)) {
        const entry = requireCrdtJsonWireObject(entryValue, 'CRDT counters entry');
        requireExactKeys(entry, ['path', 'adds'], 'CRDT counter snapshot');
        decodePath(entry.path);
        for (const write of requireJsonWireObjectArray(entry.adds, 'CRDT counter adds')) {
            decodeWrite(write, ['delta']);
        }
    }
}

function decodeNumberSection(value: JsonWireValue | undefined): void {
    const section = requireCrdtJsonWireObject(value, 'CRDT numbers section');
    for (const entryValue of Object.values(section)) {
        const entry = requireCrdtJsonWireObject(entryValue, 'CRDT numbers entry');
        requireExactKeys(entry, ['path', 'writes'], 'CRDT number snapshot');
        decodePath(entry.path);
        for (const write of requireJsonWireObjectArray(entry.writes, 'CRDT number writes')) {
            decodeWrite(write, ['merge', 'value']);
            requireOneOf(write.merge, ['min', 'max'] as const, 'CRDT number merge');
        }
    }
}

function decodeWrite(value: JsonWireObject, extraKeys: readonly string[]): void {
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

function requireJsonWireObjectArray(
    value: JsonWireValue | undefined,
    label: string
): readonly JsonWireObject[] {
    if (!isJsonWireArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    return value.map((entry) => requireCrdtJsonWireObject(entry, `${label} entry`));
}

function decodePath(value: JsonWireValue | undefined): void {
    if (!isJsonWireArray(value) || value.some((part) => typeof part !== 'string')) {
        throw new TypeError('CRDT snapshot path is invalid');
    }
}

function decodeStringArray(value: JsonWireValue | undefined, label: string): void {
    if (
        !isJsonWireArray(value) ||
        value.some((item) => typeof item !== 'string' || item.length === 0)
    ) {
        throw new TypeError(`${label} is invalid`);
    }
}

function isJsonWireArray(
    value: JsonWireValue | undefined
): value is readonly JsonWireValue[] {
    return Array.isArray(value);
}
