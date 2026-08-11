import { describe, expect, it } from 'vitest';
import { createRallarBlackBoxRtcClient } from '../../shared-test/rallar-bb-test/black-box-runner-adapter.ts';
import { validateRallarBlackBoxTestCommand } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { createRallarBlackBoxTestRuntime } from '../../shared-test/rallar-bb-test/runtime.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA,
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
} from '../../shared-test/rallar-bb-test/schema.ts';
import type { RallarBlackBoxTestRtcSendCommand } from '../../shared-test/rallar-bb-test/types.ts';

const rtcSendWithExpect = {
    kind: 'rtc.send',
    commandId: 'rtc-send-with-expect',
    connection: 'rtc',
    transport: 'realtime',
    send: {
        roomId: 'bb-group',
        data: {
            topic: 'room.negative.expect',
        },
    },
    expect: {
        outcome: 'ack',
    },
} as const satisfies RallarBlackBoxTestRtcSendCommand & Readonly<{ commandId: string }>;

function createDeterministicRuntime() {
    let now = 1_000;
    let sequence = 1;
    return createRallarBlackBoxTestRuntime({
        now: () => now++,
        idFactory: (prefix) => `${prefix}-${sequence++}`,
    });
}

describe('rtc.send expect fail-closed boundary', () => {
    it('rejects a control-dispatched rtc.send carrying expect', () => {
        expect(validateRallarBlackBoxTestCommand(rtcSendWithExpect)).toEqual({
            ok: false,
            error: 'rtc.send has unsupported field: expect.',
        });
    });

    it('still accepts a control-dispatched rtc.send without expect', () => {
        const { expect: _discarded, ...withoutExpect } = rtcSendWithExpect;
        expect(validateRallarBlackBoxTestCommand(withoutExpect)).toEqual({ ok: true });
    });

    it('rejects expect in the rtc.send command schema branch', () => {
        const result = validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, rtcSendWithExpect);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(formatJsonSchemaValidationErrors(result.errors)).toContain(
                '$.expect: Unexpected property.',
            );
        }
    });

    it('keeps the in-process black-box-runner adapter executing rtc.send with expectations', async () => {
        const runtime = createDeterministicRuntime();
        const client = createRallarBlackBoxRtcClient(runtime, {
            name: 'adapterRtc',
            roomId: 'bb-group',
            applicationId: 'rallar-server',
        });

        await client.send(
            { topic: 'room.adapter.parity', text: 'hello' },
            { response: { outcome: 'ack' } },
        );

        const sendResult = runtime.state().commandHistory.find(result => result.kind === 'rtc.send');
        expect(sendResult?.ok).toBe(true);

        const sendDiagnostic = runtime.state().events
            .find(event => event.topic === 'rallar.bb.fake.rtc.send');
        expect(sendDiagnostic?.payload).toMatchObject({
            command: {
                kind: 'rtc.send',
                expect: { outcome: 'ack' },
            },
        });
    });
});
