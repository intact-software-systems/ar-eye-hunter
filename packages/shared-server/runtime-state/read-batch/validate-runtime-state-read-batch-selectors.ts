import { type JsonWireObject, type JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import type { RuntimeStateReadBatchSelector, RuntimeStateStoredValueFields } from './runtime-state-read-batch.ts';

export function validateRuntimeStateReadBatchSelectors(
    input: JsonWireValue | readonly RuntimeStateReadBatchSelector[]
): readonly RuntimeStateReadBatchSelector[] {
    const selectors = requireDenseArray(
        input,
        'selectors'
    );
    if (selectors.length === 0) {
        throw invalidReadBatch('selectors must not be empty');
    }

    const selectorIds = new Set<string>();
    return selectors.map((inputSelector, index) => {
        const label = `selector ${index}`;
        const selector = requireRecord(inputSelector, label);
        const selectorId = requireNonEmptyString(selector.selectorId, `${label} ID`);
        if (selectorIds.has(selectorId)) {
            throw invalidReadBatch(`duplicate selector ID: ${selectorId}`);
        }
        selectorIds.add(selectorId);
        const namespace = requireNonEmptyString(
            selector.namespace,
            `${label} namespace`
        );
        return toRuntimeStateReadBatchSelector({ selector, selectorId, namespace, label });
    });
}

interface RuntimeStateReadBatchSelectorInput {
    readonly selector: JsonWireObject;
    readonly selectorId: string;
    readonly namespace: string;
    readonly label: string;
}

function toRuntimeStateReadBatchSelector(
    input: RuntimeStateReadBatchSelectorInput
): RuntimeStateReadBatchSelector {
    const { selector, selectorId, namespace, label } = input;
    if (selector.kind === 'key') {
        requireExactKeys(selector, ['selectorId', 'kind', 'namespace', 'key'], label);
        return {
            selectorId,
            kind: selector.kind,
            namespace,
            key: requireNonEmptyString(selector.key, `${label} key`)
        };
    }
    if (selector.kind === 'prefix') {
        requireExactKeys(selector, ['selectorId', 'kind', 'namespace', 'keyPrefix'], label);
        return {
            selectorId,
            kind: selector.kind,
            namespace,
            keyPrefix: requireNonEmptyString(selector.keyPrefix, `${label} key prefix`)
        };
    }
    if (selector.kind === 'prefix-containing' || selector.kind === 'prefix-expiring-after') {
        return toRuntimeStateReadBatchFilteredPrefixSelector(input);
    }
    if (selector.kind === 'prefix-suffix' || selector.kind === 'suffix') {
        return toRuntimeStateReadBatchSuffixSelector(input);
    }
    throw invalidReadBatch(`${label} kind is invalid`);
}

function toRuntimeStateReadBatchFilteredPrefixSelector(
    input: RuntimeStateReadBatchSelectorInput
): RuntimeStateReadBatchSelector {
    const { selector, selectorId, namespace, label } = input;
    const keyPrefix = requireNonEmptyString(selector.keyPrefix, `${label} key prefix`);
    if (selector.kind === 'prefix-containing') {
        requireExactKeys(selector, ['selectorId', 'kind', 'namespace', 'keyPrefix', 'storedValueContains'], label);
        return {
            selectorId,
            kind: 'prefix-containing',
            namespace,
            keyPrefix,
            storedValueContains: requireStoredValueFields(
                selector.storedValueContains,
                `${label} stored value containment`
            )
        };
    }
    requireExactKeys(selector, ['selectorId', 'kind', 'namespace', 'keyPrefix', 'expiringAfterTimestamp'], label);
    const expiringAfterTimestamp = selector.expiringAfterTimestamp;
    if (typeof expiringAfterTimestamp !== 'number' || !Number.isSafeInteger(expiringAfterTimestamp)) {
        throw invalidReadBatch(`${label} expiry floor must be a safe integer`);
    }
    return { selectorId, kind: 'prefix-expiring-after', namespace, keyPrefix, expiringAfterTimestamp };
}

function requireStoredValueFields(
    input: JsonWireValue | RuntimeStateStoredValueFields | undefined,
    label: string
): RuntimeStateStoredValueFields {
    const fields = requireRecord(input, label);
    const entries = Object.entries(fields);
    if (entries.length === 0) {
        throw invalidReadBatch(`${label} must name a field`);
    }
    if (!entries.every(([, value]) => isStoredScalar(value))) {
        throw invalidReadBatch(`${label} fields must be strings, finite numbers, booleans or null`);
    }
    return { ...fields } as RuntimeStateStoredValueFields;
}

function isStoredScalar(value: JsonWireValue): boolean {
    return value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value));
}

function toRuntimeStateReadBatchSuffixSelector(
    input: RuntimeStateReadBatchSelectorInput
): RuntimeStateReadBatchSelector {
    const { selector, selectorId, namespace, label } = input;
    if (selector.kind === 'suffix') {
        requireExactKeys(selector, ['selectorId', 'kind', 'namespace', 'keySuffix'], label);
        return {
            selectorId,
            kind: selector.kind,
            namespace,
            keySuffix: requireSuffixRangeBound(requireNonEmptyString(selector.keySuffix, `${label} key suffix`), label)
        };
    }
    requireExactKeys(
        selector,
        ['selectorId', 'kind', 'namespace', 'keyPrefix', 'keySuffix'],
        label
    );
    return {
        selectorId,
        kind: 'prefix-suffix',
        namespace,
        keyPrefix: requireNonEmptyString(selector.keyPrefix, `${label} key prefix`),
        keySuffix: requireSuffixRangeBound(requireNonEmptyString(selector.keySuffix, `${label} key suffix`), label)
    };
}

/**
 * The reversed suffix ends with the suffix's first character, and its exclusive range end increments
 * that last UTF-16 unit; a surrogate there could become a lone surrogate, so the first character
 * must lie in the Basic Multilingual Plane.
 */
function requireSuffixRangeBound(keySuffix: string, label: string): string {
    const firstUnit = keySuffix.charCodeAt(0);
    if (firstUnit >= 0xd800 && firstUnit <= 0xdfff) {
        throw invalidReadBatch(`${label} key suffix must start with a Basic Multilingual Plane character`);
    }
    return keySuffix;
}

function requireDenseArray(
    input: JsonWireValue | readonly RuntimeStateReadBatchSelector[] | undefined,
    label: string
): readonly (JsonWireValue | RuntimeStateReadBatchSelector)[] {
    if (!Array.isArray(input)) {
        throw invalidReadBatch(`${label} must be an array`);
    }
    for (let index = 0; index < input.length; index += 1) {
        if (!Object.hasOwn(input, index)) {
            throw invalidReadBatch(`${label} must be dense`);
        }
    }
    return input;
}

function requireRecord(
    input: JsonWireValue | RuntimeStateReadBatchSelector | RuntimeStateStoredValueFields | undefined,
    label: string
): JsonWireObject {
    if (!isJsonWireObject(input)) {
        throw invalidReadBatch(`${label} must be an object`);
    }
    return input;
}

function requireExactKeys(
    input: JsonWireObject,
    expected: readonly string[],
    label: string
): void {
    const actual = Object.keys(input).sort();
    const sortedExpected = [...expected].sort();
    if (
        actual.length !== sortedExpected.length ||
        actual.some((key, index) => key !== sortedExpected[index])
    ) {
        throw invalidReadBatch(`${label} fields are invalid`);
    }
}

function requireNonEmptyString(input: JsonWireValue | undefined, label: string): string {
    if (typeof input !== 'string') {
        throw invalidReadBatch(`${label} must be a string`);
    }
    if (input.length === 0) {
        throw invalidReadBatch(`${label} must not be empty`);
    }
    return input;
}

function isJsonWireObject(
    value: JsonWireValue | RuntimeStateReadBatchSelector | RuntimeStateStoredValueFields | undefined
): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidReadBatch(reason: string): Error {
    return new Error(`Invalid runtime state read batch: ${reason}`);
}
