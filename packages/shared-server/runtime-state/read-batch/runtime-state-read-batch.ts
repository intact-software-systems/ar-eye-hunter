import type { RuntimeStateEntry } from '../runtime-state-repository.ts';

export interface RuntimeStateReadBatchKeySelector {
    readonly selectorId: string;
    readonly kind: 'key';
    readonly namespace: string;
    readonly key: string;
}

export interface RuntimeStateReadBatchPrefixSelector {
    readonly selectorId: string;
    readonly kind: 'prefix';
    readonly namespace: string;
    readonly keyPrefix: string;
}

export interface RuntimeStateReadBatchPrefixSuffixSelector {
    readonly selectorId: string;
    readonly kind: 'prefix-suffix';
    readonly namespace: string;
    readonly keyPrefix: string;
    readonly keySuffix: string;
}

/** Every key in the namespace that ends with the suffix, served by an index over the reversed key. */
export interface RuntimeStateReadBatchSuffixSelector {
    readonly selectorId: string;
    readonly kind: 'suffix';
    readonly namespace: string;
    readonly keySuffix: string;
}

export type RuntimeStateReadBatchSelector =
    | RuntimeStateReadBatchKeySelector
    | RuntimeStateReadBatchPrefixSelector
    | RuntimeStateReadBatchPrefixSuffixSelector
    | RuntimeStateReadBatchSuffixSelector;

export interface RuntimeStateReadBatchSelection {
    readonly selectorId: string;
    readonly entries: readonly RuntimeStateEntry[];
}

/** The identity of every row version a batch selects, and the distinct instants those rows expire at. */
export interface RuntimeStateReadBatchVersion {
    readonly version: string;
    readonly expireAtEpochMs: readonly number[];
}

/** A store that can tell the version of a batch's selected rows without reading their values. */
export interface RuntimeStateReadBatchVersionReader {
    readRuntimeStateBatchVersion(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<RuntimeStateReadBatchVersion | undefined>;
}
