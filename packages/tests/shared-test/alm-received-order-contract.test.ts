import { describe, expect, it } from 'vitest';

import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

const command = { kind: 'messages.received', typeId: 'chat', count: 20, windowMs: 5_000 };

/** The two boundaries a `messages.received` command crosses before an agent runs it. */
function readBoundaries(candidate: ApiJsonObject) {
    return {
        schema: validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, candidate).ok,
        command: validateAlmControlCommand(candidate, 'messages.received').length === 0
    };
}

describe('an order claim in a messages.received command', () => {
    it.each([
        ['no order claim', {}],
        ['an absence claim', { absent: true }],
        ['an order claim', { ascendingBy: 'seq' }],
        ['an order claim beside a presence claim', { ascendingBy: 'seq', absent: false }]
    ])('admits %s through schema and command validation', (_label, fields) => {
        expect(readBoundaries({ ...command, ...fields })).toEqual({ schema: true, command: true });
    });

    it.each([
        ['an empty field name', { ascendingBy: '' }],
        ['a blank field name', { ascendingBy: '  ' }],
        ['a field name that is no string', { ascendingBy: 3 }],
        ['an order claim beside an absence claim, which has no order', { ascendingBy: 'seq', absent: true }]
    ])('refuses %s at both boundaries', (_label, fields) => {
        expect(readBoundaries({ ...command, ...fields })).toEqual({ schema: false, command: false });
    });

    it('says why an absence claim takes no order', () => {
        const issues = validateAlmControlCommand({ ...command, ascendingBy: 'seq', absent: true }, 'messages.received');

        expect(issues.map((issue) => issue.message)).toEqual([
            'messages.received.ascendingBy claims an order, which an absence claim (absent: true) has none of.'
        ]);
    });
});
