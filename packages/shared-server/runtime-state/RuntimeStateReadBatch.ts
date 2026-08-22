import type { RuntimeStateEntry } from './RuntimeStateRepository.ts';

export type RuntimeStateReadBatchKeySelector = Readonly<{
    selectorId: string;
    kind: 'key';
    namespace: string;
    key: string;
}>;

export type RuntimeStateReadBatchPrefixSelector = Readonly<{
    selectorId: string;
    kind: 'prefix';
    namespace: string;
    keyPrefix: string;
}>;

export type RuntimeStateReadBatchSelector =
    | RuntimeStateReadBatchKeySelector
    | RuntimeStateReadBatchPrefixSelector;

export type RuntimeStateReadBatchSelection = Readonly<{
    selectorId: string;
    entries: readonly RuntimeStateEntry[];
}>;

export type RuntimeStateReadBatchRepositoryLike = Readonly<{
    runtimeStateReadBatchCapability: true;
    runtimeStateReadBatchConsistency: 'single-database-snapshot';
    readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]>;
}>;

export function isRuntimeStateReadBatchRepositoryLike(
    repository: unknown
): repository is RuntimeStateReadBatchRepositoryLike {
    if (typeof repository !== 'object' || repository === null) {
        return false;
    }
    const candidate = repository as Readonly<Record<string, unknown>>;
    return candidate.runtimeStateReadBatchCapability === true &&
        candidate.runtimeStateReadBatchConsistency === 'single-database-snapshot' &&
        typeof candidate.readRuntimeStateBatch === 'function';
}

export function validateRuntimeStateReadBatchSelectors(
    input: unknown
): readonly RuntimeStateReadBatchSelector[] {
    const selectors = requireDenseArray(input, 'selectors');
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

export function validateRuntimeStateReadBatchResult(
    expectedSelectors: readonly RuntimeStateReadBatchSelector[],
    input: unknown
): readonly RuntimeStateReadBatchSelection[] {
    const selectors = validateRuntimeStateReadBatchSelectors(expectedSelectors);
    const results = requireDenseArray(input, 'results');
    if (results.length !== selectors.length) {
        throw invalidReadBatch(
            `results expected ${selectors.length} selections, received ${results.length}`
        );
    }

    return selectors.map((selector, index) => {
        const label = `result ${index}`;
        const result = requireRecord(results[index], label);
        requireExactKeys(result, ['selectorId', 'entries'], label);
        if (result.selectorId !== selector.selectorId) {
            throw invalidReadBatch(`${label} does not preserve caller order`);
        }
        const entries = requireDenseArray(result.entries, `${label} entries`)
            .map((entry, entryIndex) => validateEntry(entry, `${label} entry ${entryIndex}`));
        validateSelectionEntries(selector, entries, label);
        return { selectorId: selector.selectorId, entries };
    });
}

function validateSelectionEntries(
    selector: RuntimeStateReadBatchSelector,
    entries: readonly RuntimeStateEntry[],
    label: string
): void {
    if (selector.kind === 'key') {
        if (entries.length > 1) {
            throw invalidReadBatch(`${label} exact key returned multiple entries`);
        }
        if (entries[0] !== undefined && entries[0].key !== selector.key) {
            throw invalidReadBatch(`${label} exact key does not match`);
        }
    }
    else {
        for (const entry of entries) {
            if (!entry.key.startsWith(selector.keyPrefix)) {
                throw invalidReadBatch(`${label} entry does not match prefix`);
            }
        }
    }

    for (let index = 1; index < entries.length; index += 1) {
        if (compareUtf8(entries[index - 1].key, entries[index].key) >= 0) {
            throw invalidReadBatch(`${label} entries are not uniquely ordered`);
        }
    }
}

function validateEntry(input: unknown, label: string): RuntimeStateEntry {
    const entry = requireRecord(input, label);
    requireExactKeys(
        entry,
        [
            'key',
            'value',
            'expireAtTimestamp',
            'updatedTimestamp',
            'revision'
        ],
        label
    );
    const updatedTimestamp = requireNonEmptyString(
        entry.updatedTimestamp,
        `${label} updated timestamp`
    );
    const parsedUpdatedTimestamp = Date.parse(updatedTimestamp);
    if (!Number.isFinite(parsedUpdatedTimestamp)) {
        throw invalidReadBatch(`${label} updated timestamp is invalid`);
    }
    const expireAtTimestamp = entry.expireAtTimestamp;
    if (
        typeof expireAtTimestamp !== 'number' ||
        !Number.isSafeInteger(expireAtTimestamp)
    ) {
        throw invalidReadBatch(`${label} expiry is invalid`);
    }
    const revision = entry.revision;
    if (
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        Object.is(revision, -0)
    ) {
        throw invalidReadBatch(`${label} revision is invalid`);
    }
    return {
        key: requireNonEmptyString(entry.key, `${label} key`),
        value: requireString(entry.value, `${label} value`),
        expireAtTimestamp,
        updatedTimestamp: new Date(parsedUpdatedTimestamp).toISOString(),
        revision
    };
}

function requireDenseArray(input: unknown, label: string): readonly unknown[] {
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
    input: unknown,
    label: string
): Readonly<Record<string, unknown>> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw invalidReadBatch(`${label} must be an object`);
    }
    return input as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
    input: Readonly<Record<string, unknown>>,
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

function requireNonEmptyString(input: unknown, label: string): string {
    const value = requireString(input, label);
    if (value.length === 0) {
        throw invalidReadBatch(`${label} must not be empty`);
    }
    return value;
}

function requireString(input: unknown, label: string): string {
    if (typeof input !== 'string') {
        throw invalidReadBatch(`${label} must be a string`);
    }
    return input;
}

function compareUtf8(left: string, right: string): number {
    const encoder = new TextEncoder();
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
        if (leftBytes[index] !== rightBytes[index]) {
            return leftBytes[index] - rightBytes[index];
        }
    }
    return leftBytes.length - rightBytes.length;
}

function invalidReadBatch(reason: string): Error {
    return new Error(`Invalid runtime state read batch: ${reason}`);
}
