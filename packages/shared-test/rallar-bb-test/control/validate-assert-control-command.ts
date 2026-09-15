import { RALLAR_BLACK_BOX_ASSERT_OPERATORS } from '../assert/assert-value-operators.ts';
import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import type { ControlCommandIssue } from './control-command-issue.ts';
import { validateEnumField, validateStringField } from './validate-control-command-fields.ts';

export function validateAssertControlCommand(command: RallarBlackBoxTestRecord): readonly ControlCommandIssue[] {
    return [
        ...validateStringField(command, 'source', 'assert'),
        ...validateEnumField({
            record: command,
            key: 'operator',
            path: 'assert',
            allowed: RALLAR_BLACK_BOX_ASSERT_OPERATORS
        })
    ];
}
