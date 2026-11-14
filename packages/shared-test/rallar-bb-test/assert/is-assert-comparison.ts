import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';

export function isAssertComparison<T extends RallarBlackBoxTestRecord>(
    command: T
): command is T & Readonly<{ operator: 'equals' | 'sameUniqueStringSet'; }> {
    return command.operator === 'sameUniqueStringSet' ||
        (command.operator === 'equals' && command.comparisonSource !== undefined);
}
