import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { room, RtcEndpointFixture } from '../rtc-endpoint-fixture.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

// The forward its store could not persist stays with the inbound owner of the relay, which retries it.
it('retries the inbound forward owner when the forward admission answers storage-unavailable', async () => {
    const { sender, relay, receiver } = createRelayedEndpoints();
    vi.spyOn(ALOutboundMessageRuntime.prototype, 'enqueueIfAbsent').mockImplementation(async (msg) => ({
        verdict: {
            kind: 'storage-unavailable',
            cause: 'quota',
            detail: 'QuotaExceededError: The quota has been exceeded.'
        },
        message: msg,
        entries: [],
        reason: 'QuotaExceededError: The quota has been exceeded.',
        trackedReceiptAlgo: 'none'
    }));
    const message = createRoomMessage();

    expect((await sender.multicast.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted' });
    await sender.waitForDeliveries();
    await relay.waitForDeliveries();

    expect(relay.delivered.map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
    expect(await readForwardWork(relay, EntityStatus.RETRY)).toHaveLength(1);
    expect(receiver.delivered).toEqual([]);
});

interface RelayedRtcEndpoints {
    readonly sender: RtcEndpointFixture;
    readonly relay: RtcEndpointFixture;
    readonly receiver: RtcEndpointFixture;
}

function createRelayedEndpoints(): RelayedRtcEndpoints {
    const sender = new RtcEndpointFixture('sender', 'relay');
    const relay = new RtcEndpointFixture('relay', ['sender', 'receiver']);
    const receiver = new RtcEndpointFixture('receiver', 'relay');
    sender.connect(relay);
    relay.connect(sender);
    relay.connect(receiver);
    receiver.connect(relay);
    for (const endpoint of [sender, relay, receiver]) {
        endpoint.observe(1, room, ['sender', 'relay', 'receiver']);
        endpoint.observeOverlay(1);
    }
    onTestFinished(() => {
        sender.close();
        relay.close();
        receiver.close();
    });
    return { sender, relay, receiver };
}

function createRoomMessage(): ALMessage {
    const message = newALMulticastMessage(
        'sender',
        { topicId: 'data', contextId: 'room', resourceId: 'record' },
        room,
        'data',
        { value: 1 },
        { qos: { durability: { algo: 'volatile' } } }
    );
    return toALFrozenMulticastMessage(message, { recipientPeerIds: ['relay', 'receiver'], snapshotVersion: 1 });
}

async function readForwardWork(
    endpoint: RtcEndpointFixture,
    status: EntityStatus
): Promise<readonly ResourceEntry[]> {
    const page = await endpoint.inbound.workQueue.readWorkPage({
        typeId: toALInboundWorkType(endpoint.inbound.admissionStore.namespace, 'rtc'),
        status,
        maxToRead: 10,
        cursor: null
    });
    return page.entries.filter((entry) => decodeALInboundWorkEntry(entry, endpoint.inbound.admissionStore.namespace).payload.kind === 'forward-message');
}
