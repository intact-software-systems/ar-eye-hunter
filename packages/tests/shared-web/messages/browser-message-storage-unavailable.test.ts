import { describe, expect, it, vi } from 'vitest';

import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { createBrowserMessageSenderFixture } from './browser-message-sender-fixture.ts';

const COMMAND = {
    typeId: 'relic.command.v1',
    topicId: 'room.relic.command',
    payload: { kind: 'start-expedition' },
    roomId: 'room',
    peerId: 'server'
};

describe('a durable send whose browser storage is unavailable', () => {
    it('reads failed with the storage cause on a channel that refuses, and is admitted nowhere else', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admit = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementation(async (message) => toStorageUnavailableAdmission(message));

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));

        await expect.poll(() => handle.lifecycle().state).toBe('failed');
        expect(handle.lifecycle().evidence).toMatchObject({
            failure: { kind: 'storage-unavailable', cause: 'quota' },
            durabilityDowngrade: undefined,
            admittedDurable: undefined
        });
        expect(admit).toHaveBeenCalledTimes(1);
    });

    it('admits the same message once without storage on a channel that chose volatile', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admit = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementationOnce(async (message) => toStorageUnavailableAdmission(message))
            .mockImplementation(async (message) => toVolatileAdmission(message));

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('volatile'));

        await expect.poll(() => handle.lifecycle().state).toBe('queued');
        expect(admit).toHaveBeenCalledTimes(2);
        const [durable, volatile] = admit.mock.calls.map(([message]) => message);
        expect(durable!.qos?.durability).toEqual({ algo: 'local-outbox' });
        expect(volatile).toEqual({
            ...durable,
            qos: { ...durable!.qos, durability: { algo: 'volatile' } }
        });
        expect(handle.lifecycle().evidence).toMatchObject({
            admittedDurable: false,
            durabilityDowngrade: { requested: 'local-outbox', cause: 'quota' },
            failure: undefined
        });
    });

    it('states no downgrade for a send storage held, whatever the channel chose', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admit = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('volatile'));

        await expect.poll(() => handle.lifecycle().state).toBe('queued');
        expect(admit).toHaveBeenCalledTimes(1);
        expect(handle.lifecycle().evidence).toMatchObject({
            admittedDurable: true,
            durabilityDowngrade: undefined
        });
    });

    // The downgraded envelope is what the fallback carrier receives, so storage is asked once per send.
    it('hands the downgraded message to the fallback carrier without asking storage again', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admitRtc = vi.mocked(
            fixture.middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent
        )
            .mockImplementationOnce(async (message) => toStorageUnavailableAdmission(message))
            .mockImplementation(async (message) => toUnroutableAdmission(message));
        const admitWs = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementation(async (message) => toVolatileAdmission(message));

        const handle = await fixture.sender.sendTyped(
            { ...COMMAND, peerId: 'peer-b', strategy: 'rtc-with-ws-fallback' },
            toDurableChannel('volatile')
        );

        await expect.poll(() => handle.lifecycle().state).toBe('queued');
        expect(admitRtc).toHaveBeenCalledTimes(2);
        expect(admitWs).toHaveBeenCalledTimes(1);
        expect(admitWs.mock.calls[0]![0].qos?.durability).toEqual({ algo: 'volatile' });
        expect(handle.lifecycle().evidence).toMatchObject({
            admittedDurable: false,
            durabilityDowngrade: { requested: 'local-outbox', cause: 'quota' }
        });
    });
});

function toDurableChannel(
    onStorageUnavailable: BrowserTypedChannelPolicy['onStorageUnavailable']
): BrowserTypedChannelPolicy {
    return { purpose: 'command', durability: 'local-outbox', onStorageUnavailable };
}

function toStorageUnavailableAdmission(message: ALMessage): ALOutboundEnqueueResult {
    return {
        verdict: { kind: 'storage-unavailable', cause: 'quota', detail: 'QuotaExceededError' },
        message,
        entries: [],
        trackedReceiptAlgo: 'none'
    };
}

function toVolatileAdmission(message: ALMessage): ALOutboundEnqueueResult {
    return {
        verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
        message,
        entries: [],
        trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
    };
}

function toUnroutableAdmission(message: ALMessage): ALOutboundEnqueueResult {
    return {
        verdict: { kind: 'unroutable', reason: 'no-route', detail: 'No RTC route.' },
        message,
        entries: [],
        trackedReceiptAlgo: 'none'
    };
}
