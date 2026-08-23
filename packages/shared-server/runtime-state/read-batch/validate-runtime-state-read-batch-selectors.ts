import { type JsonWireObject, type JsonWireValue } from '../../rallar-system/protocol/json-wire-identity.ts';
import { type RuntimeStateReadBatchSelector } from './runtime-state-read-batch.ts';

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
            requireExactKeys(
                selector,
                ['selectorId', 'kind', 'namespace', 'keyPrefix'],
                label
            );
            return {
                selectorId,
                kind: selector.kind,
                namespace,
                keyPrefix: requireNonEmptyString(
                    selector.keyPrefix,
                    `${label} key prefix`
                )
            };
        }
        throw invalidReadBatch(`${label} kind is invalid`);
    });
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
    input: JsonWireValue | RuntimeStateReadBatchSelector | undefined,
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
    value: JsonWireValue | RuntimeStateReadBatchSelector | undefined
): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidReadBatch(reason: string): Error {
    return new Error(`Invalid runtime state read batch: ${reason}`);
}
