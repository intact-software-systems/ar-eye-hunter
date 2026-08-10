import type {
    CanonicalGroupTopologyConfigField,
    CanonicalGroupTopologyConfigPatch,
    GroupTopologyConfigPatch,
    GroupTopologyKindSetting,
} from './graph-topology-management-types.ts';

const CONFIG_KEYS = [
    'topologyKind',
    'degreeLimit',
    'treeMinSize',
    'meshMinSize',
    'meshParamK',
] as const;

const TOPOLOGY_KINDS: readonly GroupTopologyKindSetting[] = [
    'auto',
    'star',
    'tree',
    'mesh',
];

export function toCanonicalGroupTopologyConfigPatch(
    value: unknown,
): CanonicalGroupTopologyConfigPatch {
    const patch = requireExactRecord(value, [], 'topology config patch');
    return {
        topologyKind: toCanonicalField(
            patch,
            'topologyKind',
            isTopologyKind,
        ),
        degreeLimit: toCanonicalField(patch, 'degreeLimit', isFiniteNumber),
        treeMinSize: toCanonicalField(patch, 'treeMinSize', isFiniteNumber),
        meshMinSize: toCanonicalField(patch, 'meshMinSize', isFiniteNumber),
        meshParamK: toCanonicalField(patch, 'meshParamK', isFiniteNumber),
    };
}

export function isPreserveOnlyCanonicalGroupTopologyConfigPatch(
    patch: CanonicalGroupTopologyConfigPatch,
): boolean {
    return patch.topologyKind.action === 'preserve' &&
        patch.degreeLimit.action === 'preserve' &&
        patch.treeMinSize.action === 'preserve' &&
        patch.meshMinSize.action === 'preserve' &&
        patch.meshParamK.action === 'preserve';
}

export function readCanonicalGroupTopologyConfigPatch(
    value: unknown,
): CanonicalGroupTopologyConfigPatch {
    const record = requireExactRecord(
        value,
        CONFIG_KEYS,
        'canonical topology config patch',
    );
    return {
        topologyKind: readCanonicalField(
            record.topologyKind,
            'topologyKind',
            isTopologyKind,
        ),
        degreeLimit: readCanonicalField(
            record.degreeLimit,
            'degreeLimit',
            isFiniteNumber,
        ),
        treeMinSize: readCanonicalField(
            record.treeMinSize,
            'treeMinSize',
            isFiniteNumber,
        ),
        meshMinSize: readCanonicalField(
            record.meshMinSize,
            'meshMinSize',
            isFiniteNumber,
        ),
        meshParamK: readCanonicalField(
            record.meshParamK,
            'meshParamK',
            isFiniteNumber,
        ),
    };
}

export function fromCanonicalGroupTopologyConfigPatch(
    value: unknown,
): GroupTopologyConfigPatch {
    const canonical = readCanonicalGroupTopologyConfigPatch(value);
    const patch: {
        -readonly [K in keyof GroupTopologyConfigPatch]: GroupTopologyConfigPatch[K];
    } = {};
    for (const key of CONFIG_KEYS) {
        const field = canonical[key];
        if (field.action === 'set') {
            patch[key] = field.value as never;
        } else if (field.action === 'clear') {
            switch (key) {
                case 'topologyKind':
                    patch.topologyKind = null;
                    break;
                case 'degreeLimit':
                    patch.degreeLimit = null;
                    break;
                case 'treeMinSize':
                    patch.treeMinSize = null;
                    break;
                case 'meshMinSize':
                    patch.meshMinSize = null;
                    break;
                case 'meshParamK':
                    patch.meshParamK = null;
                    break;
            }
        }
    }
    return patch;
}

function toCanonicalField<T>(
    record: Record<string, unknown>,
    key: string,
    validate: (value: unknown) => value is T,
): CanonicalGroupTopologyConfigField<T> {
    if (!Object.hasOwn(record, key)) return { action: 'preserve' };
    const value = record[key];
    if (value === null) return { action: 'clear' };
    if (!validate(value)) {
        throw new TypeError(`Topology config patch ${key} is invalid`);
    }
    return { action: 'set', value };
}

function readCanonicalField<T>(
    value: unknown,
    key: string,
    validate: (value: unknown) => value is T,
): CanonicalGroupTopologyConfigField<T> {
    const record = requireRecord(value, `canonical topology field ${key}`);
    if (record.action === 'preserve') {
        requireExactKeys(record, ['action'], `canonical topology field ${key}`);
        return { action: 'preserve' };
    }
    if (record.action === 'set') {
        requireExactKeys(
            record,
            ['action', 'value'],
            `canonical topology field ${key}`,
        );
        if (!validate(record.value)) {
            throw new TypeError(`Canonical topology field ${key} value is invalid`);
        }
        return { action: 'set', value: record.value };
    }
    if (record.action === 'clear') {
        requireExactKeys(record, ['action'], `canonical topology field ${key}`);
        return { action: 'clear' };
    }
    throw new TypeError(`Canonical topology field ${key} action is invalid`);
}

function requireExactRecord(
    value: unknown,
    expectedKeys: readonly string[],
    label: string,
): Record<string, unknown> {
    const record = requireRecord(value, label);
    if (expectedKeys.length === 0) {
        const unknown = Object.keys(record).filter((key) =>
            !(CONFIG_KEYS as readonly string[]).includes(key)
        );
        if (unknown.length > 0) {
            throw new TypeError(`${label} contains unknown fields: ${unknown.join(', ')}`);
        }
        return record;
    }
    requireExactKeys(record, expectedKeys, label);
    return record;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
    ) {
        throw new TypeError(`${label} must be a plain object`);
    }
    return value as Record<string, unknown>;
}

function requireExactKeys(
    record: Record<string, unknown>,
    expectedKeys: readonly string[],
    label: string,
): void {
    const actual = Object.keys(record).toSorted();
    const expected = [...expectedKeys].toSorted();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
    }
}

function isTopologyKind(value: unknown): value is GroupTopologyKindSetting {
    return (TOPOLOGY_KINDS as readonly unknown[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
