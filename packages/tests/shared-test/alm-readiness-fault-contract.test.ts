import { describe, expect, it } from 'vitest';

import { decodeBlackBoxRallarFaultInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts';
import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

describe('ALM WS readiness fault command', () => {
    const command = { kind: 'fault.inject', faultId: 'hold', carrier: 'ws', match: { typeId: 'held' }, action: 'not-ready', remaining: 10 };
    it('admits the WS readiness action through schema, command validation and browser decoding', () => {
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
        expect(validateAlmControlCommand(command, 'fault.inject')).toEqual([]);
        expect(decodeBlackBoxRallarFaultInput(command).right).toMatchObject({ carrier: 'ws', action: 'not-ready' });
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
