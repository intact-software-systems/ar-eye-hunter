import type {
    RallarBlackBoxTestAssertComparisonOperator,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';

export const RALLAR_BLACK_BOX_ASSERT_COMPARISON_OPERATORS = [
    'equals',
    'gte',
    'sameUniqueStringSet'
] as const satisfies readonly RallarBlackBoxTestAssertComparisonOperator[];

/** `sameUniqueStringSet` always compares two results; the others compare a result only when they name one. */
export function isAssertComparison<T extends RallarBlackBoxTestRecord>(
    command: T
): command is T & Readonly<{ operator: RallarBlackBoxTestAssertComparisonOperator; }> {
    return command.operator === 'sameUniqueStringSet' ||
        (RALLAR_BLACK_BOX_ASSERT_COMPARISON_OPERATORS.some((operator) => operator === command.operator) &&
            command.comparisonSource !== undefined);
}
