import { describe, expect, it } from 'vitest';

import { decodeBlackBoxRallarFaultInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts';
import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const COMMAND = {
    kind: 'fault.inject',
    faultId: 'forge-granted',
    match: { typeId: 'granted.message' },
    remaining: 'until-cleared'
} as const;

const REWRITE_OFF_RTC_MESSAGE = 'fault.inject.action.rewrite is offered on the rtc carrier only.';
const REWRITE_SHAPE_MESSAGE = 'fault.inject.action.rewrite must be "strip-proof" or an object naming forgeSender.principal.';

describe('the fault.inject rewrite action', () => {
    it.each([{ forgeSender: { principal: 'principal-charlie' } }, 'strip-proof'] as const)(
        'admits the rtc rewrite %j through schema, command validation and browser decoding',
        (rewrite) => {
            const command = { ...COMMAND, carrier: 'rtc', action: { rewrite } };

            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
            expect(validateAlmControlCommand(command, 'fault.inject')).toEqual([]);
            expect(decodeBlackBoxRallarFaultInput(command).right).toEqual({
                faultId: 'forge-granted',
                carrier: 'rtc',
                match: { controlType: undefined, typeId: 'granted.message', msgId: undefined },
                rewrite,
                remaining: 'until-cleared'
            });
        }
    );

    it('refuses a rewrite on the ws carrier, where no frame is rewritten', () => {
        const command = { ...COMMAND, carrier: 'ws', action: { rewrite: 'strip-proof' } };

        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
        expect(validateAlmControlCommand(command, 'fault.inject')).toEqual([
            expect.objectContaining({ message: REWRITE_OFF_RTC_MESSAGE })
        ]);
        expect(decodeBlackBoxRallarFaultInput(command).left?.message).toBe(REWRITE_OFF_RTC_MESSAGE);
    });

    it.each([{ forgeSender: {} }, { forgeSender: { principal: '' } }, 'forge-sender', { stripProof: true }])(
        'refuses the rewrite %j, which names neither a forged principal nor strip-proof',
        (rewrite) => {
            const command = { ...COMMAND, carrier: 'rtc', action: { rewrite } };

            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
            expect(validateAlmControlCommand(command, 'fault.inject')).toEqual([
                expect.objectContaining({ message: REWRITE_SHAPE_MESSAGE })
            ]);
            expect(decodeBlackBoxRallarFaultInput(command).left?.message).toBe(REWRITE_SHAPE_MESSAGE);
        }
    );
});
