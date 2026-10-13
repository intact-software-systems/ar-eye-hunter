import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
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
import { NotReadyException } from '@shared/queuebox/resource-inbox/not-ready-exception.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { ALWorkBatchTestObserver } from '../alm/work/al-work-batch-test-observer.ts';
import { createOriginSnapshot, createRtcOriginOverlayFixture } from '../multicast/rtc-origin-overlay-fixture.ts';
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
        [{ kind: 'unroutable', reason: 'rate-limited', detail: 'Observed local quota refusal' }, EntityStatus.RETRY],
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
    vi.spyOn(receiver.multicast, 'enqueueAllIfAbsent').mockImplementation(async (messages) =>
        messages.map((message) => ({
            verdict,
            message,
            entries: [],
            trackedReceiptAlgo: 'none'
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

    const work = await readControlWork(receiver, ownerStatus);
    expect(work).toHaveLength(1);
    expect(work[0]!.dequeueAudit.attempts).toBe(verdict.kind === 'unroutable' && verdict.reason === 'rate-limited' ? 0 : 1);
    if (verdict.kind === 'unroutable' && verdict.reason === 'rate-limited') {
        expect(Number(work[0]!.dequeueAudit.nextTs!.epochMilliseconds) - Date.now()).toBe(1);
    }
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
    onTestFinished(async () => {
        const outcomes = await Promise.allSettled([sender.close(), receiver.close()]);
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw toError(failure.reason);
        }
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

it('retains the whole quota-refused batch without admitting either control through individual fallback', async () => {
    let now = CONTROL_RECOVERY_STARTED_AT_MS;
    let ready = false;
    const admitted: string[] = [];
    const run = createControlRecoveryRuntime(() => now, async (messages) => {
        if (!ready && messages.length > 1) {
            throw new NotReadyException(1251);
        }
        admitted.push(...messages.map((message) => message.id.msgId));
    });
    const entries = await Promise.all([1, 2].map((sequence) => seedControlRecoveryWork(run, sequence, CONTROL_RECOVERY_STARTED_AT_MS + 10_000)));
    await run.runtime.ready();
    await run.batches.waitForPublishedBatches();
    for (const entry of entries) {
        expect(await run.resources.workQueue.getItem(entry.key))
            .toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 0, nextTs: expect.anything() } });
        expect(Number((await run.resources.workQueue.getItem(entry.key))!.dequeueAudit.nextTs!.epochMilliseconds)).toBe(CONTROL_RECOVERY_STARTED_AT_MS + 1251);
    }
    expect(admitted).toEqual([]);
    ready = true;
    now = CONTROL_RECOVERY_STARTED_AT_MS + 1251;
    await expect.poll(async () => {
        await run.engine.executeOnce();
        await run.batches.waitForPublishedBatches();
        await run.engine.stop();
        return Promise.all(entries.map((entry) => run.resources.workQueue.getItem(entry.key)));
    }).toMatchObject(entries.map(() => ({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 1 } })));
    expect(admitted).toEqual(['recovery-control-1', 'recovery-control-2']);
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

it.each([
    new Error('rate-limited'),
    Object.assign(new Error('RTC enqueue rate limit exceeded'), { name: 'NotReadyException' }),
    new NotReadyException(0),
    new NotReadyException(-1),
    new NotReadyException(1.5),
    new NotReadyException(Number.MAX_SAFE_INTEGER + 1)
])('charges an ordinary processing attempt for an unvalidated readiness exception %s', async (error) => {
    const run = createControlRecoveryRuntime(() => CONTROL_RECOVERY_STARTED_AT_MS, async () => {
        throw error;
    });
    const entry = await seedControlRecoveryWork(run, 1, CONTROL_RECOVERY_STARTED_AT_MS + 10_000);
    await run.runtime.ready();
    await run.batches.waitForPublishedBatches();
    const released = (await run.resources.workQueue.getItem(entry.key))!;
    expect(released).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    expect(Number(released.dequeueAudit.nextTs!.epochMilliseconds)).toBe(CONTROL_RECOVERY_STARTED_AT_MS + 1);
});

it.each([
    { deadline: CONTROL_RECOVERY_STARTED_AT_MS + 1250, next: CONTROL_RECOVERY_STARTED_AT_MS + 1250, admitted: [] },
    { deadline: CONTROL_RECOVERY_STARTED_AT_MS + 1251, next: CONTROL_RECOVERY_STARTED_AT_MS + 1251, admitted: [] },
    { deadline: CONTROL_RECOVERY_STARTED_AT_MS + 1252, next: CONTROL_RECOVERY_STARTED_AT_MS + 1251, admitted: ['recovery-control-1'] }
])('clips quota readiness to expiry $deadline and never sends an expired control', async ({ deadline, next, admitted: expected }) => {
    let now = CONTROL_RECOVERY_STARTED_AT_MS;
    const admitted: string[] = [];
    const run = createControlRecoveryRuntime(() => now, async (messages) => {
        if (now < CONTROL_RECOVERY_STARTED_AT_MS + 1251) {
            throw new NotReadyException(1251);
        }
        admitted.push(...messages.map((message) => message.id.msgId));
    });
    const entry = await seedControlRecoveryWork(run, 1, deadline);
    await run.runtime.ready();
    await run.batches.waitForPublishedBatches();
    const released = (await run.resources.workQueue.getItem(entry.key))!;
    expect(released).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 0 } });
    expect(Number(released.dequeueAudit.nextTs!.epochMilliseconds)).toBe(next);
    now = CONTROL_RECOVERY_STARTED_AT_MS + 1251;
    await expect.poll(async () => {
        await run.engine.executeOnce();
        await run.batches.waitForPublishedBatches();
        await run.engine.stop();
        return deadline > now ? (await run.resources.workQueue.getItem(entry.key))?.status : await run.resources.workQueue.getItem(entry.key);
    }).toBe(deadline > now ? EntityStatus.COMPLETED : undefined);
    expect(admitted).toEqual(expected);
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

interface ControlRecoveryRuntime {
    readonly runtime: ALInboundMessageRuntime;
    readonly resources: ALInboundMessageRuntime.Resources;
    readonly engine: InboxOutboxEngine;
    readonly batches: ALWorkBatchTestObserver;
    readonly delivered: string[];
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
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: 'receiver',
        nowMs,
        queueEngine: engine,
        random: () => 0.5,
        toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
    });
    const batches = new ALWorkBatchTestObserver();
    const diagnostics: ALInboundRuntimeDiagnosticsSink = Object.assign(() => {}, {
        acknowledgementCapture: { evidence: ALInboundAcknowledgementEvidence, batchObservations: batches.batchObservations }
    });
    const delivered: string[] = [];
    const runtime = new ALInboundMessageRuntime({
        ...resources,
        carrier: 'rtc',
        planIncomingMessage: (message, _source, observations) =>
            planALMessageHandling(message, { ...observations, selfPeerId: 'receiver', fromPeerId: 'sender' }),
        dispatchInboxEntry: async (entry) => {
            delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        sendControlMessages,
        diagnostics
    });
    onTestFinished(async () => {
        await runtime.dispose();
        await engine.stop();
    });
    return { runtime, resources, engine, batches, delivered };
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

it('keeps a local quota refusal without an eligible forecast on the ordinary retry budget', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(CONTROL_RECOVERY_STARTED_AT_MS);
    const multicast = createRtcOriginOverlayFixture({
        snapshot: createOriginSnapshot(['a', 'b'], 1),
        nextHopPeerIds: ['b'],
        rateLimiter: RateLimiter.init(1_000, 0)
    });
    const run = createControlRecoveryRuntime(() => CONTROL_RECOVERY_STARTED_AT_MS, (messages) => multicast.manager.handoffControlMessages(messages));
    const entry = await seedControlRecoveryWork(run, 1, CONTROL_RECOVERY_STARTED_AT_MS + 10_000);
    await run.runtime.ready();
    await run.batches.waitForPublishedBatches();
    const released = (await run.resources.workQueue.getItem(entry.key))!;
    expect(released).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    expect(Number(released.dequeueAudit.nextTs!.epochMilliseconds)).toBe(CONTROL_RECOVERY_STARTED_AT_MS + 1);
    expect(await multicast.resources.admissionStore.hasSentMessageAdmission('recovery-control-1')).toBe(false);
    expect(multicast.channels.b!.sent).toEqual([]);
});

it('keeps per-control expiry clipping and delivers new work while the quota batch waits', async () => {
    let now = CONTROL_RECOVERY_STARTED_AT_MS;
    const admitted: string[] = [];
    const run = createControlRecoveryRuntime(() => now, async (messages) => {
        if (now < CONTROL_RECOVERY_STARTED_AT_MS + 1251) {
            throw new NotReadyException(1251);
        }
        admitted.push(...messages.map((message) => message.id.msgId));
    });
    const entries = await Promise.all([1250, 10_000].map((ttl, index) => seedControlRecoveryWork(run, index + 1, now + ttl)));
    await run.runtime.ready();
    await run.batches.waitForPublishedBatches();
    const released = await Promise.all(entries.map((entry) => run.resources.workQueue.getItem(entry.key)));
    expect(released.map((entry) => Number(entry!.dequeueAudit.nextTs!.epochMilliseconds) - now)).toEqual([1250, 1251]);
    expect(released.map((entry) => entry!.dequeueAudit.attempts)).toEqual([0, 0]);
    const independent = newALUnicastMessage('sender', { topicId: 'tasks', resourceId: 'new-progress', contextId: 'queue' }, 'receiver', 'tasks.job.v1', {
        text: 'new work'
    });
    const acceptance = await run.runtime.admitIncomingMessage(independent, { kind: 'rtc-peer', peerId: 'sender' });
    expect(acceptance.left).toBeUndefined();
    expect(acceptance.right).toMatchObject({ kind: 'admitted' });
    await run.batches.waitForPublishedBatches();
    expect(run.delivered).toEqual([independent.id.msgId]);
    expect(await Promise.all(entries.map((entry) => run.resources.workQueue.getItem(entry.key)))).toEqual(released);
    now += 1251;
    await expect.poll(async () => {
        await run.engine.executeOnce();
        await run.batches.waitForPublishedBatches();
        await run.engine.stop();
        return run.resources.workQueue.getItem(entries[1]!.key);
    }).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 1 } });
    expect(await run.resources.workQueue.getItem(entries[0]!.key)).toBeUndefined();
    expect(admitted).toEqual(['recovery-control-2']);
});
