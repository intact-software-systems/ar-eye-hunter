import { describe, expect, it } from 'vitest';

import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

const command = { kind: 'messages.received', typeId: 'chat', count: 20, windowMs: 600_000 };

/** The two boundaries a `messages.received` command crosses before an agent runs it. */
function readBoundaries(candidate: ApiJsonObject) {
    return {
        schema: validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, candidate).ok,
        command: validateAlmControlCommand(candidate, 'messages.received').length === 0
    };
}

describe('a stall window in a messages.received command', () => {
    it.each([
        ['no stall window', {}],
        ['a stall window', { stallMs: 30_000 }],
        ['a stall window beside a presence claim', { stallMs: 1, absent: false }]
    ])('admits %s through schema and command validation', (_label, fields) => {
        expect(readBoundaries({ ...command, ...fields })).toEqual({ schema: true, command: true });
    });

    it.each([
        ['no time at all', { stallMs: 0 }],
        ['a negative window', { stallMs: -1 }],
        ['a fraction of a millisecond', { stallMs: 1.5 }],
        ['a window that is no number', { stallMs: '30000' }]
    ])('refuses %s at both boundaries', (_label, fields) => {
        expect(readBoundaries({ ...command, ...fields })).toEqual({ schema: false, command: false });
    });

    it('refuses a stall window beside an absence claim, which holds its whole window', () => {
        expect(readBoundaries({ ...command, stallMs: 30_000, absent: true })).toEqual({ schema: true, command: false });
        expect(validateAlmControlCommand({ ...command, stallMs: 30_000, absent: true }, 'messages.received').map((issue) => issue.message))
            .toEqual(['messages.received.stallMs ends a count that stops arriving, which an absence claim (absent: true) never ends early.']);
    });
});
