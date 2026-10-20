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

/** A batch read together with the version of exactly the rows it returned; undefined when it returned none. */
export interface RuntimeStateVersionedReadBatch {
    readonly selections: readonly RuntimeStateReadBatchSelection[];
    readonly version: RuntimeStateReadBatchVersion | undefined;
}

/** A store that can tell the version of a batch's selected rows, alone or with their values in one read. */
export interface RuntimeStateReadBatchVersionReader {
    readRuntimeStateBatchVersion(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<RuntimeStateReadBatchVersion | undefined>;
    readRuntimeStateBatchWithVersion(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<RuntimeStateVersionedReadBatch>;
    /** The version of each selector group's rows, from one read; undefined for a group that selects no row. */
    readRuntimeStateBatchVersions(
        selectorGroups: readonly (readonly RuntimeStateReadBatchSelector[])[]
    ): Promise<readonly (RuntimeStateReadBatchVersion['version'] | undefined)[]>;
}
