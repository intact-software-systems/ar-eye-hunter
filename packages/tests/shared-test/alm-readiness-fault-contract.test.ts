import { describe, expect, it } from 'vitest';

import { decodeBlackBoxRallarFaultInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts';
import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

describe('ALM WS readiness fault command', () => {
    const command = { kind: 'fault.inject', faultId: 'hold', carrier: 'ws', match: { typeId: 'held' }, action: 'not-ready', remaining: 10 };
    it.each(['ws', 'rtc'])('preserves an explicit until-cleared %s lifetime through every command boundary', (carrier) => {
        const held = { ...command, carrier, action: carrier === 'ws' ? 'not-ready' : 'drop', remaining: 'until-cleared' };
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, held).ok).toBe(true);
        expect(validateAlmControlCommand(held, 'fault.inject')).toEqual([]);
        expect(decodeBlackBoxRallarFaultInput(held).right).toMatchObject({ remaining: 'until-cleared' });
    });
    it.each(['forever', '', null, {}, true])('rejects invalid fault lifetime %j', (remaining) => {
        const invalid = { ...command, remaining };
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, invalid).ok).toBe(false);
        expect(validateAlmControlCommand(invalid, 'fault.inject').length).toBeGreaterThan(0);
        expect(decodeBlackBoxRallarFaultInput(invalid).left).toBeDefined();
    });
    it('admits the WS readiness action through schema, command validation and browser decoding', () => {
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
        expect(validateAlmControlCommand(command, 'fault.inject')).toEqual([]);
        expect(decodeBlackBoxRallarFaultInput(command).right).toMatchObject({ carrier: 'ws', action: 'not-ready' });
    });
    it.each([
        { carrier: 'ws', action: 'drop' },
        { carrier: 'ws', action: { delayMs: 10 } },
        { carrier: 'rtc', action: 'drop' }
    ])('preserves the supported $carrier frame fault $action', ({ carrier, action }) => {
        const frameFault = { ...command, carrier, action };
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, frameFault).ok).toBe(true);
        expect(validateAlmControlCommand(frameFault, 'fault.inject')).toEqual([]);
        expect(decodeBlackBoxRallarFaultInput(frameFault).right).toMatchObject({ carrier, action });
    });
    it('rejects WS-only readiness and delay on RTC before runtime invocation', () => {
        for (const action of ['not-ready', { delayMs: 10 }]) {
            const rtcCommand = { ...command, carrier: 'rtc', action };
            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, rtcCommand).ok).toBe(false);
            expect(validateAlmControlCommand(rtcCommand, 'fault.inject').length).toBeGreaterThan(0);
            expect(decodeBlackBoxRallarFaultInput(rtcCommand).left).toBeDefined();
        }
    });
});
