import { describe, expect, it } from 'vitest';

import { decodeBlackBoxRallarFaultInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts';
import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

const command = {
    kind: 'fault.inject',
    faultId: 'lossy',
    carrier: 'ws',
    match: { typeId: 'chat' },
    remaining: 'until-cleared'
};
const loss = { loss: { ratio: 0.1, seed: 7 } };
const jitter = { jitter: { minDelayMs: 20, maxDelayMs: 80, seed: 7 } };

/** The three boundaries a `fault.inject` command crosses before a page arms it. */
function readBoundaries(candidate: ApiJsonObject) {
    return {
        schema: validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, candidate).ok,
        command: validateAlmControlCommand(candidate, 'fault.inject').length === 0,
        browser: decodeBlackBoxRallarFaultInput(candidate).right !== undefined
    };
}

describe('seeded loss and jitter in a fault.inject command', () => {
    it.each([
        ['a loss on ws', 'ws', loss],
        ['a loss on rtc', 'rtc', loss],
        ['a jitter on ws', 'ws', jitter],
        ['a loss of every frame', 'ws', { loss: { ratio: 1, seed: 0 } }],
        ['a jitter of one fixed delay', 'ws', { jitter: { minDelayMs: 40, maxDelayMs: 40, seed: 1 } }]
    ])('admits %s through schema, command validation and browser decoding', (_label, carrier, action) => {
        const seeded = { ...command, carrier, action };

        expect(readBoundaries(seeded)).toEqual({ schema: true, command: true, browser: true });
        expect(decodeBlackBoxRallarFaultInput(seeded).right).toMatchObject({ carrier, action });
    });

    it('refuses a jitter on rtc, whose channel applies no delay, at every boundary', () => {
        expect(readBoundaries({ ...command, carrier: 'rtc', action: jitter }))
            .toEqual({ schema: false, command: false, browser: false });
    });

    it.each([
        ['a ratio of zero', { loss: { ratio: 0, seed: 7 } }],
        ['a ratio above one', { loss: { ratio: 1.2, seed: 7 } }],
        ['a loss with no seed', { loss: { ratio: 0.1 } }],
        ['a seed that is no integer', { loss: { ratio: 0.1, seed: 0.5 } }],
        ['a loss field nothing reads', { loss: { ratio: 0.1, seed: 7, burst: 2 } }],
        ['a negative minimum delay', { jitter: { minDelayMs: -5, maxDelayMs: 80, seed: 7 } }],
        ['a fractional delay', { jitter: { minDelayMs: 0.5, maxDelayMs: 80, seed: 7 } }],
        ['a jitter with no maximum', { jitter: { minDelayMs: 20, seed: 7 } }],
        ['a loss beside a jitter', { ...loss, ...jitter }]
    ])('refuses %s at every boundary', (_label, action) => {
        expect(readBoundaries({ ...command, action })).toEqual({ schema: false, command: false, browser: false });
    });

    it('refuses a maximum below its minimum where the two are read together', () => {
        const reversed = { ...command, action: { jitter: { minDelayMs: 80, maxDelayMs: 20, seed: 7 } } };

        expect(validateAlmControlCommand(reversed, 'fault.inject').length).toBeGreaterThan(0);
        expect(decodeBlackBoxRallarFaultInput(reversed).left).toBeDefined();
    });
});
