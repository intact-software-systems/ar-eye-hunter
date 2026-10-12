import { RALLAR_BLACK_BOX_COMMAND_ASSERT_OPERATORS } from '../assert/assert-value-operators.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { toControlCommandIssue, type ControlCommandIssue } from './control-command-issue.ts';
import { validateEnumField, validateStringField } from './validate-control-command-fields.ts';

export function validateAssertControlCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    const issues: ControlCommandIssue[] = [
        ...validateStringField(command, 'source', 'assert'),
        ...validateEnumField({
            record: command,
            key: 'operator',
            path: 'assert',
            allowed: RALLAR_BLACK_BOX_COMMAND_ASSERT_OPERATORS
        })
    ];
    if (typeof command.source === 'string' && command.source.trim().length === 0) {
        issues.push(toControlCommandIssue('assert.source must be a non-empty string.'));
    }
    if (command.operator === 'sameUniqueStringSet') {
        if (typeof command.comparisonSource !== 'string' || command.comparisonSource.trim().length === 0) {
            issues.push(toControlCommandIssue('assert.comparisonSource must be a non-empty string.'));
        }
        if (command.expected !== undefined) {
            issues.push(toControlCommandIssue('assert.expected is unsupported for sameUniqueStringSet.'));
        }
    }
    else if (command.comparisonSource !== undefined) {
        issues.push(toControlCommandIssue('assert.comparisonSource is unsupported for this operator.'));
    }
    return issues;
}
