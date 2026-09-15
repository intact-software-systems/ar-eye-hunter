import { RALLAR_BLACK_BOX_ASSERT_OPERATORS } from '../assert/assert-value-operators.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import type { ControlCommandIssue } from './control-command-issue.ts';
import { validateEnumField, validateRequiredField, validateStringField } from './validate-control-command-fields.ts';

export function validateAssertControlCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    return [
        ...validateRequiredField(command, 'source', 'assert'),
        ...validateStringField(command, 'source', 'assert'),
        ...validateRequiredField(command, 'operator', 'assert'),
        ...validateEnumField({
            record: command,
            key: 'operator',
            path: 'assert',
            allowed: RALLAR_BLACK_BOX_ASSERT_OPERATORS
        })
    ];
}
