import { describe, expect, it, vi } from 'vitest';

import {
    BrowserALStorageAvailability,
    type ALStorageAvailability
} from '@shared-web/browser/al-runtime/browser-al-storage-availability.ts';
import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
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

describe('the connect\'s storage availability at the dispatch', () => {
    it('skips the durable lane while storage is missing, so a refusing channel fails without reaching the carrier', async () => {
        const fixture = createStorageFixture(MISSING);
        const admit = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));

        await expect.poll(() => handle.lifecycle().state).toBe('failed');
        expect(handle.lifecycle().evidence.failure).toEqual({
            kind: 'storage-unavailable',
            cause: 'missing'
        });
        expect(admit).not.toHaveBeenCalled();
    });

    it('sends a missing-storage message on a volatile channel with one carrier admission, without storage', async () => {
        const fixture = createStorageFixture(MISSING);
        const admit = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementation(async (message) => toVolatileAdmission(message));

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('volatile'));

        await expect.poll(() => handle.lifecycle().state).toBe('queued');
        expect(admit).toHaveBeenCalledTimes(1);
        expect(admit.mock.calls[0]![0].qos?.durability).toEqual({ algo: 'volatile' });
        expect(handle.lifecycle().evidence.durabilityDowngrade).toEqual({
            requested: 'local-outbox',
            cause: 'missing'
        });
    });

    it('never skips a volatile send', async () => {
        const fixture = createStorageFixture(MISSING);
        const admit = vi.spyOn(
            fixture.middleware.middleware.webSocketQueueBox,
            'enqueueOutboxIfAbsent'
        );

        await fixture.sender.sendWs(COMMAND, {
            ...toDurableChannel('refuse'),
            durability: 'volatile'
        });

        expect(admit).toHaveBeenCalledTimes(1);
    });

    it('tries the durable lane again after a quota failure and reads available once storage holds a send', async () => {
        const fixture = createStorageFixture(AVAILABLE);
        const admit = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementationOnce(async (message) => toStorageUnavailableAdmission(message));
        const storage = fixture.middleware.middleware.storageAvailability;

        const refused = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));
        await expect.poll(() => refused.lifecycle().state).toBe('failed');
        expect(storage.availability.get()).toEqual({
            kind: 'unavailable',
            reason: { cause: 'quota', detail: 'QuotaExceededError' }
        });

        const held = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));
        await expect.poll(() => held.lifecycle().state).toBe('queued');
        expect(admit).toHaveBeenCalledTimes(2);
        expect(storage.availability.get()).toEqual(AVAILABLE);
    });

    // The request never settles here, as a browser prompting its user: no send may wait for it.
    it('asks for persistent storage on the first durable admission only', async () => {
        const requestPersist = vi.fn(() => new Promise<boolean>(() => {}));
        const events: ALStorageEvent[] = [];
        const fixture = createStorageFixture(
            AVAILABLE,
            requestPersist,
            (event) => events.push(event)
        );
        vi.mocked(fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent)
            .mockImplementation(async (message) => toLaneAdmission(message));

        const volatile = await fixture.sender.sendWs(COMMAND, {
            ...toDurableChannel('refuse'),
            durability: 'volatile'
        });
        await expect.poll(() => volatile.lifecycle().state).toBe('queued');
        expect(requestPersist).not.toHaveBeenCalled();

        const first = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));
        const second = await fixture.sender.sendWs(COMMAND, toDurableChannel('refuse'));
        await expect.poll(() => [first.lifecycle().state, second.lifecycle().state]).toEqual([
            'queued',
            'queued'
        ]);

        expect(requestPersist).toHaveBeenCalledTimes(1);
        expect(events).toEqual([]);
    });
});

describe('a downgraded send whose storage stays unavailable', () => {
    // The downgrade asks storage exactly once more: a re-admission that also finds no storage ends the send.
    it('fails a downgraded send whose volatile re-admission also finds storage unavailable, keeping the downgrade', async () => {
        const fixture = createBrowserMessageSenderFixture();
        const admit = vi.mocked(
            fixture.middleware.middleware.webSocketQueueBox.enqueueOutboxIfAbsent
        )
            .mockImplementation(async (message) => toStorageUnavailableAdmission(message));

        const handle = await fixture.sender.sendWs(COMMAND, toDurableChannel('volatile'));

        await expect.poll(() => handle.lifecycle().state).toBe('failed');
        expect(admit).toHaveBeenCalledTimes(2);
        expect(handle.lifecycle().evidence).toMatchObject({
            failure: { kind: 'storage-unavailable', cause: 'quota' },
            durabilityDowngrade: { requested: 'local-outbox', cause: 'quota' }
        });
    });
});

const AVAILABLE: ALStorageAvailability = { kind: 'available' };
const MISSING: ALStorageAvailability = {
    kind: 'unavailable',
    reason: { cause: 'missing', detail: 'No IndexedDB.' }
};

function createStorageFixture(
    initial: ALStorageAvailability,
    requestPersist: (() => Promise<boolean>) | undefined = undefined,
    storage: (event: ALStorageEvent) => void = () => {}
): ReturnType<typeof createBrowserMessageSenderFixture> {
    const storageAvailability = new BrowserALStorageAvailability({
        initial,
        requestPersist,
        storage
    });
    return createBrowserMessageSenderFixture(
        undefined,
        undefined,
        createDefaultApiMiddlewareTestDouble({ middleware: { storageAvailability } })
    );
}

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

// Admitted on the lane its durability names, as the carrier's runtime routes it.
function toLaneAdmission(message: ALMessage): ALOutboundEnqueueResult {
    return {
        verdict: {
            kind: 'admitted',
            durable: message.qos?.durability?.algo !== 'volatile',
            queuedAttempts: 1
        },
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
