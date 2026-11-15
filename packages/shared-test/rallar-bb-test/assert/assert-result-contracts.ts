import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type { RallarBlackBoxTestAssertOperator } from '../rallar-black-box-test-contracts.ts';
import type { RallarBlackBoxTestAssertComparisonOperator } from './is-assert-comparison.ts';

export type RallarBlackBoxTestAssertResultValue =
    | RallarBlackBoxTestValueAssertResultValue
    | RallarBlackBoxTestComparisonAssertResultValue;

export interface RallarBlackBoxTestValueAssertResultValue {
    readonly operator: Exclude<RallarBlackBoxTestAssertOperator, 'sameUniqueStringSet'>;
    readonly expected?: ApiJsonValue;
    readonly actual?: ApiJsonValue;
    readonly exists: boolean;
    readonly passed: boolean;
}

export interface RallarBlackBoxTestComparisonAssertResultValue {
    readonly operator: RallarBlackBoxTestAssertComparisonOperator;
    readonly expected?: never;
    readonly actual?: ApiJsonValue;
    readonly comparisonActual?: ApiJsonValue;
    readonly exists: boolean;
    readonly comparisonExists: boolean;
    readonly passed: boolean;
}
