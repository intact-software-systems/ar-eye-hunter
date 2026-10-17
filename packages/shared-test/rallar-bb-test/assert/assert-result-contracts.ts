import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { RallarBlackBoxTestAssertOperator } from '../rallar-black-box-test-contracts.ts';

export type RallarBlackBoxTestAssertResultValue =
    | RallarBlackBoxTestValueAssertResultValue
    | RallarBlackBoxTestSetAssertResultValue;

export interface RallarBlackBoxTestValueAssertResultValue {
    readonly operator: Exclude<RallarBlackBoxTestAssertOperator, 'sameUniqueStringSet'>;
    readonly expected?: ApiJsonValue;
    readonly actual?: ApiJsonValue;
    readonly exists: boolean;
    readonly passed: boolean;
}

export interface RallarBlackBoxTestSetAssertResultValue {
    readonly operator: 'sameUniqueStringSet';
    readonly expected?: never;
    readonly actual?: ApiJsonValue;
    readonly comparisonActual?: ApiJsonValue;
    readonly exists: boolean;
    readonly comparisonExists: boolean;
    readonly passed: boolean;
}
