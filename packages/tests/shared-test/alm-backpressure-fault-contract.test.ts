import { describe, expect, it } from 'vitest';

import { decodeBlackBoxRallarFaultInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts';
import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const COMMAND = {
    kind: 'fault.inject',
    faultId: 'hold-at-watermark',
    match: { typeId: 'congested.message' },
    action: 'backpressure',
    remaining: 'until-cleared'
} as const;

describe('the fault.inject backpressure action', () => {
    it.each(['ws', 'rtc'] as const)('admits a %s backpressure hold through schema, command validation and browser decoding', (carrier) => {
        const command = { ...COMMAND, carrier };

        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
        expect(validateAlmControlCommand(command, 'fault.inject')).toEqual([]);
        expect(decodeBlackBoxRallarFaultInput(command).right).toEqual({
            faultId: 'hold-at-watermark',
            carrier,
            match: { controlType: undefined, typeId: 'congested.message', msgId: undefined },
            action: 'backpressure',
            remaining: 'until-cleared'
        });
    });

    it('keeps a finite backpressure count as the number of originations it holds', () => {
        const command = { ...COMMAND, carrier: 'rtc', remaining: 40 };

        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
        expect(decodeBlackBoxRallarFaultInput(command).right).toMatchObject({ action: 'backpressure', remaining: 40 });
    });

    it('names backpressure among the rtc carrier\'s actions when it refuses a readiness fault there', () => {
        const command = { ...COMMAND, carrier: 'rtc', action: 'not-ready' };

        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
        expect(validateAlmControlCommand(command, 'fault.inject')).toEqual([
            expect.objectContaining({ message: 'fault.inject.action must be "drop" or "backpressure" on the rtc carrier.' })
        ]);
        expect(decodeBlackBoxRallarFaultInput(command).left?.message).toBe(
            'fault.inject.action must be "drop" or "backpressure" on the rtc carrier.'
        );
    });

    it('names backpressure among the transport actions when an action is none of them', () => {
        const command = { ...COMMAND, carrier: 'ws', action: 'stall' };

        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
        expect(validateAlmControlCommand(command, 'fault.inject')).toEqual([
            expect.objectContaining({
                message: 'fault.inject.action must be "drop", "not-ready", "backpressure" or an object with delayMs.'
            })
        ]);
        expect(decodeBlackBoxRallarFaultInput(command).left?.message).toBe(
            'fault.inject.action must be "drop", "not-ready", "backpressure" or an object naming delayMs.'
        );
    });
});
