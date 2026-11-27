import 'fake-indexeddb/auto';
import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-error-message-prefixes.ts';
import { decodeBlackBoxRallarMessageSendInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-message-send-input.ts';
import { RallarValidationError } from '@shared/api/rallar-validation.ts';

import {
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';
import { openFacadeDelivery } from './browser-runtime-facade-test-double.ts';

const connection = {
    connection: 'aliceAlm',
    actor: 'alice',
    roomId: 'room-1',
    rallar: {
        apiBaseUrl: 'https://api.example.test',
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        username: 'alice',
        password: 'secret'
    }
};
const witnessedSend = {
    connection: 'aliceAlm',
    carrier: 'rtc',
    typeId: 'alm.conformance',
    payload: { n: 1 },
    handleId: 'h-1',
    timeoutMs: 100,
    observe: 'call-refused'
};

async function loadConnectedRuntime(): Promise<BlackBoxRallarRuntime> {
    const runtime = await loadRuntime();
    onTestFinished(async () => {
        await runtime.close();
    });
    await runtime.connect(connection);
    return runtime;
}

beforeEach(() => {
    resetFacade();
});

describe('a messages.send that observes the refusal of its call', () => {
    it('returns every issue the product refused the call with, in order, by path and code alone', async () => {
        const runtime = await loadConnectedRuntime();
        facade.behavior.typedSend.mockRejectedValue(
            new RallarValidationError('Rallar message input is invalid.', [
                { path: '$.peerId', code: 'unsupported', message: 'The server is no RTC peer.' },
                { path: '$.scope', code: 'invalid-scope', message: 'Scope must be room, world or principal.' }
            ])
        );

        expect(await runtime.sendMessage(witnessedSend)).toStrictEqual({
            handleId: 'h-1',
            carrier: 'rtc',
            callRefusal: [
                { path: '$.peerId', code: 'unsupported' },
                { path: '$.scope', code: 'invalid-scope' }
            ]
        });
    });

    it('fails the send, naming that the call was not refused, when the call opens a handle', async () => {
        const runtime = await loadConnectedRuntime();
        facade.behavior.typedSend.mockResolvedValue(openFacadeDelivery('rtc', { kind: 'admitted', durable: false, queuedAttempts: 0 }));

        await expect(runtime.sendMessage(witnessedSend)).rejects.toThrow(
            new RegExp(`^${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.sendNotRefused}`)
        );
    });

    it('fails the send with the call\'s own error when the call fails other than by a validation refusal', async () => {
        const runtime = await loadConnectedRuntime();
        const closed = new Error('ws lane closed');
        facade.behavior.typedSend.mockRejectedValue(closed);

        await expect(runtime.sendMessage(witnessedSend)).rejects.toBe(closed);
    });

    it('fails the send with the product\'s own validation error when opening its channel refuses, before any call', async () => {
        const runtime = await loadConnectedRuntime();
        const refusedChannel = new RallarValidationError('Rallar channel definition is invalid.', [
            { path: '$.topicId', code: 'reserved-ws-topic', message: 'Rallar WS topic is reserved.' }
        ]);
        facade.behavior.typedChannelOpen.mockImplementation(() => {
            throw refusedChannel;
        });

        await expect(runtime.sendMessage(witnessedSend)).rejects.toBe(refusedChannel);
        expect(facade.records.typedSends).toEqual([]);
    });

    it.each([
        ['another observation', { ...witnessedSend, observe: 'rejected' }, 'messages.send.observe must be call-refused.'],
        ['an observation beside a replay', {
            connection: 'aliceAlm',
            timeoutMs: 100,
            observe: 'call-refused',
            replayOnCarrier: { handleId: 'h-1', carrier: 'ws' }
        }, 'messages.send names observe beside replayOnCarrier; a replay names only the handle and its carrier.']
    ])('refuses %s before any send', (_label, input, message) => {
        expect(decodeBlackBoxRallarMessageSendInput(input).left).toEqual({ message });
    });
});
