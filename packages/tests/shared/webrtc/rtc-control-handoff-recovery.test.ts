import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { type ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import {
    computeALInboundWorkEntry,
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { ALInboundAcknowledgementEvidence } from '@shared/alm/inbound/control/al-inbound-acknowledgement-evidence.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { ALWorkBatchTestObserver } from '../alm/work/al-work-batch-test-observer.ts';
import { RtcEndpointFixture } from '../rtc-endpoint-fixture.ts';

const CONTROL_RECOVERY_STARTED_AT_MS = 1791883286866;

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it('retries the inbound ACK owner when RTC control handoff conflicts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { receiver, sender } = createConnectedEndpoints();
    // The handoff and its one retry both conflict; a single send commits through `commitBundle` alone.
    vi.spyOn(receiver.outbound.admissionStore, 'commitBundle')
        .mockResolvedValueOnce('conflict')
        .mockResolvedValueOnce('conflict');
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
        [{ kind: 'unroutable', reason: 'circuit-open', detail: 'Observed circuit open' }, EntityStatus.RETRY],
        [{ kind: 'deferred', reason: 'not-yet-in-sync', detail: 'Observed pending sync' }, EntityStatus.RETRY],
        [{ kind: 'failed', detail: 'Observed failure' }, EntityStatus.RETRY],
        [
            { kind: 'storage-unavailable', cause: 'quota', detail: 'QuotaExceededError: The quota has been exceeded.' },
            EntityStatus.RETRY
        ],
        [{ kind: 'skipped', reason: 'pending-terminated', detail: 'Observed termination' }, EntityStatus.NON_RETRYABLE],
        [{ kind: 'superseded', detail: 'Observed supersession' }, EntityStatus.NON_RETRYABLE],
        [{ kind: 'expired', detail: 'Observed expiry' }, EntityStatus.NON_RETRYABLE]
    ] as const
)('maps RTC control result %s to inbound owner %s', async (verdict, ownerStatus) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { receiver, sender } = createConnectedEndpoints();
    const enqueueAllIfAbsent = ALOutboundMessageRuntime.prototype.enqueueAllIfAbsent;
    // Only the receiver's control admission answers the observed verdict; every other admission runs for real.
    vi.spyOn(ALOutboundMessageRuntime.prototype, 'enqueueAllIfAbsent').mockImplementation(async function (
        this: ALOutboundMessageRuntime<ALOutboundTransportMessage>,
        messages
    ) {
        return messages.every((message) => message.id.senderId === 'receiver')
            ? messages.map((message) => ({ verdict, message, entries: [], trackedReceiptAlgo: 'none' }))
            : await enqueueAllIfAbsent.call(this, messages);
    });
    const message = newALUnicastMessage(
        'sender',
        { topicId: 'tasks', resourceId: 'status', contextId: 'queue' },
        'receiver',
        'tasks.job.v1',
        { text: 'classify control ownership' },
        { qos: { ack: { algo: 'hop' }, durability: { algo: 'volatile' } } }
    );

    await sender.sendAndWaitForDelivery(message);

    const work = await readControlWork(receiver, ownerStatus);
    expect(work).toHaveLength(1);
    expect(work[0]!.dequeueAudit.attempts).toBe(1);
});

it('preserves independent idempotent fallback after a partially admitted ordinary batch', async () => {
    const admitted = new Set<string>();
    const run = createControlRecoveryRuntime(() => CONTROL_RECOVERY_STARTED_AT_MS, async (messages) => {
        for (const message of messages) {
            if (message.id.msgId === 'recovery-control-2') {
                throw new Error('Storage unavailable after partial batch admission');
            }
            admitted.add(message.id.msgId);
        }
    });
    const entries = await Promise.all([1, 2].map((sequence) => seedControlRecoveryWork(run, sequence, CONTROL_RECOVERY_STARTED_AT_MS + 10_000)));
    await run.runtime.ready();
    await run.batches.waitForPublishedBatches();
    expect(await run.resources.workQueue.getItem(entries[0]!.key)).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 1 } });
    expect(await run.resources.workQueue.getItem(entries[1]!.key)).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    expect([...admitted]).toEqual(['recovery-control-1']);
});

it('exhausts a genuine failing control after exactly twenty charged attempts with ordinary backoff', async () => {
    let now = CONTROL_RECOVERY_STARTED_AT_MS;
    const run = createControlRecoveryRuntime(() => now, async () => {
        throw new Error('Storage admission failed');
    });
    const entry = await seedControlRecoveryWork(run, 1, CONTROL_RECOVERY_STARTED_AT_MS + 600_000);
    await run.runtime.ready();
    await run.batches.waitForPublishedBatches();
    const delays = [1, 2, 4, 8, 16, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];
    for (let attempt = 1; attempt <= 20; attempt++) {
        let released = (await run.resources.workQueue.getItem(entry.key))!;
        expect(released).toMatchObject({ status: attempt === 20 ? EntityStatus.FAILED : EntityStatus.RETRY, dequeueAudit: { attempts: attempt } });
        if (attempt === 20) {
            expect(released.dequeueAudit.nextTs).toBeUndefined();
            break;
        }
        expect(Number(released.dequeueAudit.nextTs!.epochMilliseconds) - now).toBe(delays[attempt - 1]);
        now = Number(released.dequeueAudit.nextTs!.epochMilliseconds);
        await expect.poll(async () => {
            await run.engine.executeOnce();
            await run.batches.waitForPublishedBatches();
            await run.engine.stop();
            released = (await run.resources.workQueue.getItem(entry.key))!;
            return released.dequeueAudit.attempts;
        }).toBe(attempt + 1);
    }
});

interface ConnectedRtcEndpoints {
    readonly sender: RtcEndpointFixture;
    readonly receiver: RtcEndpointFixture;
}

function createConnectedEndpoints(): ConnectedRtcEndpoints {
    const sender = new RtcEndpointFixture('sender', 'receiver');
    onTestFinished(() => sender.close());
    const receiver = new RtcEndpointFixture('receiver', 'sender');
    onTestFinished(() => receiver.close());
    sender.connect(receiver);
    receiver.connect(sender);
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

interface ControlRecoveryRuntime {
    readonly runtime: ALInboundMessageRuntime;
    readonly resources: ALInboundMessageRuntime.Resources;
    readonly engine: InboxOutboxEngine;
    readonly batches: ALWorkBatchTestObserver;
}

function createControlRecoveryRuntime(
    nowMs: () => number,
    sendControlMessages: ALInboundMessageRuntime.Dependencies['sendControlMessages']
): ControlRecoveryRuntime {
    vi.spyOn(Date, 'now').mockImplementation(nowMs);
    const engine = new InboxOutboxEngine({
        nowEpochMs: nowMs,
        random: () => 0.5,
        reportTaskFailure: (_id, error) => {
            throw error;
        }
    });
    onTestFinished(() => engine.stop());
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: 'receiver',
        nowMs,
        queueEngine: engine,
        random: () => 0.5,
        toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox', Temporal.Now.instant())
    });
    const batches = new ALWorkBatchTestObserver();
    const diagnostics: ALInboundRuntimeDiagnosticsSink = Object.assign(() => {}, {
        acknowledgementCapture: { evidence: ALInboundAcknowledgementEvidence, batchObservations: batches.batchObservations }
    });
    const runtime = new ALInboundMessageRuntime({
        ...resources,
        carrier: 'rtc',
        planIncomingMessage: (message, _source, observations) =>
            planALMessageHandling(message, { ...observations, selfPeerId: 'receiver', fromPeerId: 'sender' }),
        dispatchInboxEntry: async () => {},
        sendControlMessages,
        diagnostics
    });
    onTestFinished(() => runtime.dispose());
    return { runtime, resources, engine, batches };
}

async function seedControlRecoveryWork(run: ControlRecoveryRuntime, sequence: number, expireAtTimestamp: number): Promise<ResourceEntry> {
    const nowMs = run.resources.clock.nowMs();
    const msg = newALAckControlMessage({ v: 3, msgId: `recovery-control-${sequence}`, senderId: 'receiver', ts: nowMs }, {
        ackedMsgId: `recovery-subject-${sequence}`,
        fromPeerId: 'receiver',
        toPeerId: 'sender',
        originPeerId: 'sender',
        logicalRecipientPeerId: 'receiver',
        carrier: 'rtc',
        status: 'delivered',
        observedAtEpochMs: nowMs
    });
    const computed = computeALInboundWorkEntry({
        namespace: run.resources.admissionStore.namespace,
        effectId: msg.id.msgId,
        payload: { kind: 'send-control', msg },
        observedAtMs: nowMs,
        expireAtTimestamp,
        carrier: 'rtc'
    });
    return await run.resources.workQueue.enqueueIfAbsent(computed.entry);
}
