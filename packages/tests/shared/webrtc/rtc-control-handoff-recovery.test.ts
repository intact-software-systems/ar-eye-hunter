import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { RtcEndpointFixture } from '../rtc-endpoint-fixture.ts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it('retries the inbound ACK owner when RTC control handoff conflicts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { receiver, sender } = createConnectedEndpoints();
    vi.spyOn(receiver.outbound.admissionStore, 'commitBundles').mockResolvedValueOnce('conflict');
    vi.spyOn(receiver.outbound.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
    vi.spyOn(receiver.outbound.admissionStore, 'retainPendingAdmission')
        .mockResolvedValue('conflict');
    const message = newALUnicastMessage(
        'sender',
        { topicId: 'tasks', resourceId: 'job', contextId: 'queue' },
        'receiver',
        'tasks.job.v1',
        { text: 'deliver once' },
        { qos: { ack: { algo: 'hop' }, durability: { algo: 'volatile' } } }
    );

    await sender.sendAndWaitForDelivery(message);

    const retriedControls = await readControlWork(receiver, EntityStatus.RETRY);
    expect(retriedControls).toHaveLength(1);
    expect(retriedControls[0]).toMatchObject({
        dequeueAudit: { attempts: 1, nextTs: expect.anything() }
    });
});

it.each(
    [
        [{ kind: 'pending' }, EntityStatus.COMPLETED],
        [{ kind: 'admitted', durable: true, queuedAttempts: 1 }, EntityStatus.COMPLETED],
        [{ kind: 'admitted', durable: false, queuedAttempts: 0 }, EntityStatus.COMPLETED],
        [{ kind: 'duplicate' }, EntityStatus.COMPLETED],
        [{ kind: 'unroutable', reason: 'no-route', detail: 'Observed no route' }, EntityStatus.RETRY],
        [{ kind: 'deferred', reason: 'not-yet-in-sync', detail: 'Observed pending sync' }, EntityStatus.RETRY],
        [{ kind: 'failed', detail: 'Observed failure' }, EntityStatus.RETRY],
        [{ kind: 'skipped', reason: 'pending-terminated', detail: 'Observed termination' }, EntityStatus.NON_RETRYABLE],
        [{ kind: 'superseded', detail: 'Observed supersession' }, EntityStatus.NON_RETRYABLE],
        [{ kind: 'expired', detail: 'Observed expiry' }, EntityStatus.NON_RETRYABLE]
    ] as const
)('maps RTC control result %s to inbound owner %s', async (verdict, ownerStatus) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { receiver, sender } = createConnectedEndpoints();
    vi.spyOn(receiver.multicast, 'enqueueAllIfAbsent').mockImplementation(async (messages) =>
        messages.map((message) => ({
            verdict,
            message,
            entries: []
        }))
    );
    const message = newALUnicastMessage(
        'sender',
        { topicId: 'tasks', resourceId: 'status', contextId: 'queue' },
        'receiver',
        'tasks.job.v1',
        { text: 'classify control ownership' },
        { qos: { ack: { algo: 'hop' }, durability: { algo: 'volatile' } } }
    );

    await sender.sendAndWaitForDelivery(message);

    expect(await readControlWork(receiver, ownerStatus)).toHaveLength(1);
});

interface ConnectedRtcEndpoints {
    readonly sender: RtcEndpointFixture;
    readonly receiver: RtcEndpointFixture;
}

function createConnectedEndpoints(): ConnectedRtcEndpoints {
    const sender = new RtcEndpointFixture('sender', 'receiver');
    const receiver = new RtcEndpointFixture('receiver', 'sender');
    sender.connect(receiver);
    receiver.connect(sender);
    onTestFinished(() => {
        sender.close();
        receiver.close();
    });
    return { sender, receiver };
}

async function readControlWork(
    receiver: RtcEndpointFixture,
    status: EntityStatus
): Promise<readonly ResourceEntry[]> {
    const page = await receiver.inbound.workQueue.readWorkPage({
        typeId: toALInboundWorkType(receiver.inbound.admissionStore.namespace, 'rtc'),
        status,
        maxToRead: 10,
        cursor: null
    });
    return page.entries.filter((entry) => {
        const work = decodeALInboundWorkEntry(entry, receiver.inbound.admissionStore.namespace);
        return work.payload.kind === 'send-control';
    });
}
