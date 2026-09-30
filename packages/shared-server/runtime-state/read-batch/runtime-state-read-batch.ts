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

export type RuntimeStateReadBatchSelector =
    | RuntimeStateReadBatchKeySelector
    | RuntimeStateReadBatchPrefixSelector
    | RuntimeStateReadBatchPrefixSuffixSelector;

export interface RuntimeStateReadBatchSelection {
    readonly selectorId: string;
    readonly entries: readonly RuntimeStateEntry[];
}
