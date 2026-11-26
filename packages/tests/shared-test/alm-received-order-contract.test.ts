import { describe, expect, it } from 'vitest';

import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

import {
    computeAlmMessagesReceivedBoundaryAdmission,
    toAlmMessagesReceivedCommand
} from './alm-messages-received-boundaries.ts';

describe('an order claim in a messages.received command', () => {
    it.each([
        ['no order claim', {}],
        ['an absence claim', { absent: true }],
        ['an order claim', { ascendingBy: 'seq' }],
        ['an order claim beside a presence claim', { ascendingBy: 'seq', absent: false }]
    ])('admits %s through schema and command validation', (_label, fields) => {
        expect(computeAlmMessagesReceivedBoundaryAdmission(toAlmMessagesReceivedCommand(fields))).toEqual({ schema: true, command: true });
    });

    it.each([
        ['an empty field name', { ascendingBy: '' }],
        ['a blank field name', { ascendingBy: '  ' }],
        ['a field name that is no string', { ascendingBy: 3 }]
    ])('refuses %s at both boundaries', (_label, fields) => {
        expect(computeAlmMessagesReceivedBoundaryAdmission(toAlmMessagesReceivedCommand(fields))).toEqual({ schema: false, command: false });
    });

    it('refuses an order claim beside an absence claim where the two are read together', () => {
        expect(computeAlmMessagesReceivedBoundaryAdmission(toAlmMessagesReceivedCommand({ ascendingBy: 'seq', absent: true }))).toEqual({
            schema: true,
            command: false
        });
    });

    it('still names the field a malformed messages.received lacks', () => {
        const { windowMs: _windowMs, ...withoutWindow } = toAlmMessagesReceivedCommand({});
        const checked = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, withoutWindow);

        expect(checked.errors.map((error) => error.message)).toContain('Missing required property windowMs.');
    });

    it('says why an absence claim takes no order', () => {
        const issues = validateAlmControlCommand(toAlmMessagesReceivedCommand({ ascendingBy: 'seq', absent: true }), 'messages.received');

        expect(issues.map((issue) => issue.message)).toEqual([
            'messages.received.ascendingBy claims an order, which an absence claim (absent: true) has none of.'
        ]);
    });
});
