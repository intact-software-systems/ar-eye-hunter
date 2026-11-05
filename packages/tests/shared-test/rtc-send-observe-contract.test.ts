import { describe, expect, it } from 'vitest';

import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { decodeRtcSendObserve } from '@shared-test/rallar-bb-test/schema/decode-rtc-send-observe.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const COMMAND = {
    kind: 'rtc.send',
    commandId: 'refused-publication',
    connection: 'receiver',
    transport: 'messages.rtc',
    send: { topicId: 'room.granted', payload: { publication: 'refused' } }
} as const;

const OBSERVE_MESSAGE = 'rtc.send.observe must be "rejected".';

describe('the rtc.send observe option', () => {
    it('admits observe: rejected through schema, command validation and browser decoding', () => {
        const command = { ...COMMAND, observe: 'rejected' };

        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(true);
        expect(validateRallarBlackBoxTestCommand(command)).toEqual({ ok: true });
        expect(decodeRtcSendObserve(command.observe).right).toBe('rejected');
    });

    it('reads an absent observe as a send that must settle, through all three', () => {
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, COMMAND).ok).toBe(true);
        expect(validateRallarBlackBoxTestCommand(COMMAND)).toEqual({ ok: true });
        expect(decodeRtcSendObserve(undefined).right).toBe('not-failed');
    });

    it.each(['acknowledged', 'failed', true, ['rejected']])('refuses observe %j through all three', (observe) => {
        const command = { ...COMMAND, observe };

        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, command).ok).toBe(false);
        expect(validateRallarBlackBoxTestCommand(command)).toEqual({ ok: false, error: OBSERVE_MESSAGE, messages: [OBSERVE_MESSAGE] });
        expect(decodeRtcSendObserve(observe).left).toBe(OBSERVE_MESSAGE);
    });
});
