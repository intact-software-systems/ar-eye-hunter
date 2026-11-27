import { describe, expect, it } from 'vitest';

import { ALM_INVALID_RUNTIME_RESULT_CODE } from '@shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts';
import type { RallarBlackBoxBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type {
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRecord
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { RALLAR_BLACK_BOX_COMMAND_CAPABILITIES } from '@shared-test/rallar-bb-test/schema/rallar-black-box-command-capabilities.ts';

import { createBrowserRallarRequiredMethodsTestDouble } from './browser-rallar-required-methods-test-double.ts';

const WITNESSED_SEND: RallarBlackBoxTestMessagesSendCommand = {
    kind: 'messages.send',
    commandId: 'send-to-server',
    connection: 'aliceRtc',
    carrier: 'rtc',
    typeId: 'alm.conformance',
    payload: { n: 1 },
    toPeer: 'server',
    observe: 'call-refused'
};
const STATED_REFUSAL = {
    handleId: 'send-to-server',
    carrier: 'rtc',
    callRefusal: [{ path: '$.peerId', code: 'unsupported' }]
};

interface BoundaryAdmission {
    readonly schema: boolean;
    readonly command: boolean;
}

function computeBoundaryAdmission(command: RallarBlackBoxTestRecord): BoundaryAdmission {
    const recipe = { schemaVersion: 1, recipeId: 'alm-call-refusal', name: 'alm call refusal', commands: [command] };
    return {
        schema: validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe).ok,
        command: validateRallarBlackBoxTestCommand(command).ok
    };
}

function createRefusingPage(
    sendMessage: RallarBlackBoxBrowserRallarRuntime['sendMessage']
): RallarBlackBoxBrowserRallarRuntime {
    return {
        ...createBrowserRallarRequiredMethodsTestDouble(),
        connect: async () => ({ connected: true }),
        send: async () => ({ sent: true }),
        sendMessage,
        refreshRoom: async () => undefined,
        close: async () => ({ closed: true }),
        health: async () => ({ connected: true })
    };
}

describe('a messages.send that observes the refusal of its call', () => {
    it('is admitted by the recipe schema and by command validation', () => {
        expect(computeBoundaryAdmission(WITNESSED_SEND)).toEqual({ schema: true, command: true });
    });

    it('is refused at both boundaries when it names another observation', () => {
        expect(computeBoundaryAdmission({ ...WITNESSED_SEND, observe: 'rejected' })).toEqual({
            schema: false,
            command: false
        });
    });

    it('is refused beside a replay, which re-admits an envelope no call refused', () => {
        const replay = {
            kind: 'messages.send',
            commandId: 'replay-observed',
            observe: 'call-refused',
            replayOnCarrier: { handleId: 'send-to-server', carrier: 'ws' }
        };

        expect(validateRallarBlackBoxTestCommand(replay)).toMatchObject({
            ok: false,
            messages: [
                'messages.send.observe is not allowed on a replay; a replay names only connection and replayOnCarrier.'
            ]
        });
    });

    it('names observe in the capability an author reads', () => {
        const capability = RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.find(({ kind }) => kind === 'messages.send');

        expect(capability?.optionalFields).toContain('observe');
        expect(capability?.description).toContain('observe call-refused');
    });
});

describe('the adapter running a send that observes the refusal of its call', () => {
    it('hands the page the observation and returns every issue the page stated as the step\'s value', async () => {
        const stated = {
            ...STATED_REFUSAL,
            callRefusal: [{ path: '$.peerId', code: 'unsupported' }, { path: '$.scope', code: 'invalid-scope' }]
        };
        const asked: RallarBlackBoxTestRecord[] = [];
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
            readSession: () => undefined,
            rallarRuntime: createRefusingPage(async (input) => {
                asked.push(input);
                return stated;
            })
        });

        const result = await runtime.execute(WITNESSED_SEND);

        expect(result).toMatchObject({ ok: true, value: stated });
        expect(asked).toMatchObject([{ handleId: 'send-to-server', toPeer: 'server', observe: 'call-refused' }]);
    });

    it.each([
        ['a handle\'s result', {
            handleId: 'send-to-server',
            msgId: 'msg-1',
            carrier: 'rtc',
            status: 'accepted',
            traceId: 'trace-send-1',
            corrId: 'msg-1'
        }, 'callRefusal'],
        ['an issue with no code', { ...STATED_REFUSAL, callRefusal: [{ path: '$.peerId' }] }, 'callRefusal.0.code'],
        ['an issue whose path is no string', {
            ...STATED_REFUSAL,
            callRefusal: [{ path: 3, code: 'unsupported' }]
        }, 'callRefusal.0.path'],
        ['an unknown carrier', { ...STATED_REFUSAL, carrier: 'quic' }, 'carrier']
    ])('fails the step when the page answers with %s', async (_label, answered, field) => {
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
            readSession: () => undefined,
            rallarRuntime: createRefusingPage(async () => answered)
        });

        const result = await runtime.execute(WITNESSED_SEND);

        expect(result).toMatchObject({
            ok: false,
            error: {
                code: ALM_INVALID_RUNTIME_RESULT_CODE,
                message: `The page runtime returned no usable messages.send call refusal result.${field}.`
            }
        });
    });
});
