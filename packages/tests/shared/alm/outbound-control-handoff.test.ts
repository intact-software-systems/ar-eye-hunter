import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    newALEventRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import {
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultIndexedDbALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import {
    ALInboundMessageRuntime,
    type ALInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import {
    decodeALInboundWorkEntry,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type {
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { RetryableConflictError } from '@shared/resilience/TryWith.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import '../../setup-browser-indexeddb.ts';
import {
    claimOutboundTestWork,
    createOutboundMessage,
    createOutboundTestRuntimeFor,
    releaseOutboundTestWork,
    runOutboundWorkTask
} from './outbound-runtime-test-fixture.ts';
import {
    decodeOutboundTestPayload,
    type OutboundTestPayload
} from './outbound-test-payload.ts';

const TEST_NOW_MS = Date.now();

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('hands initial control ownership to durable pending work without waiting for outbound serialization', async () => {
    const message = createControlMessage('control-handoff');
    const browserLocks = stubImmediateBrowserLock();
    const observer = createCountingIndexedDbOperationObserver();
    const stores = createControlStores('control-handoff', observer);
    await stores.admissionStore.ready();
    observer.reset();
    const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
    let admissionMetadataCommitCount = 0;
    vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
        admissionMetadataCommitCount += 1;
        return await commitBundle(bundle);
    });
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const runtime = createControlRuntime(stores, (event) => diagnostics.push(event));

    const result = await runtime.enqueueIfAbsent(message);

    expect(result.status).toBe('pending-admission');
    expect(admissionMetadataCommitCount).toBe(0);
    expect(browserLocks.requestCount()).toBe(0);
    const entries = await Promise.all(
        (await stores.workQueue.getAllKeys()).map((key) => stores.workQueue.getItem(key))
    );
    expect(entries.filter((entry) => entry?.typeId.startsWith('AL_OUTBOUND:'))).toHaveLength(1);
    expect(entries.filter((entry) => entry?.typeId === 'AL_OUTBOUND_IDENTITY')).toHaveLength(1);
    expect(entries.filter((entry) => entry?.key.topicId === 'AL_OUTBOUND_MESSAGE')).toHaveLength(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({
        kind: 'commit-phases',
        origin: 'send',
        commitOutcome: 'committed'
    }));
    expect(diagnostics.some((event) => (event.kind === 'sender-queue-wait' || event.kind === 'browser-lock-wait') && event.origin === 'send')).toBe(false);
    expect(observer.getCounts().byKind.write).toBe(1);
});

it('converges two runtime handoffs on one pending owner and one eventual transport', async () => {
    const message = createControlMessage('concurrent-handoff');
    const browserLocks = stubImmediateBrowserLock();
    const stores = createControlStores('concurrent-handoff');
    await stores.admissionStore.ready();
    let transportCount = 0;
    const first = createControlRuntime(stores, undefined, () => transportCount += 1);
    const second = createControlRuntime(stores, undefined, () => transportCount += 1);

    const results = await Promise.all([
        first.enqueueIfAbsent(message),
        second.enqueueIfAbsent(message)
    ]);

    expect(results.map((result) => result.status)).toEqual(['pending-admission', 'pending-admission']);
    const retained = await readControlRows(stores);
    expect(retained.filter((entry) => entry.typeId.startsWith('AL_OUTBOUND:'))).toHaveLength(1);
    expect(retained.filter((entry) => entry.typeId === 'AL_OUTBOUND_IDENTITY')).toHaveLength(1);
    expect(retained.filter((entry) => entry.key.topicId === 'AL_OUTBOUND_MESSAGE')).toHaveLength(1);
    expect(browserLocks.requestCount()).toBe(0);

    for (let pass = 0; pass < 3; pass += 1) {
        await runOutboundWorkTask(first);
        await runOutboundWorkTask(second);
    }

    expect(transportCount).toBe(1);
    expect(browserLocks.requestCount()).toBe(1);
    expect((await second.enqueueIfAbsent(message)).status).toBe('duplicate');
    expect(transportCount).toBe(1);
});

it.each(
    [
        { state: 'NEW', expectedStatus: 'pending-admission' },
        { state: 'RESERVED', expectedStatus: 'pending-admission' },
        { state: 'RETRY', expectedStatus: 'pending-admission' },
        { state: 'COMPLETED', expectedStatus: 'skipped' }
    ] as const
)('does not duplicate a $state control handoff owner', async ({ state, expectedStatus }) => {
    const message = createControlMessage(`repeated-${state.toLowerCase()}`);
    const browserLocks = stubImmediateBrowserLock();
    const stores = createControlStores(`repeated-${state.toLowerCase()}`);
    await stores.admissionStore.ready();
    const retainPendingAdmission = stores.admissionStore.retainPendingAdmission.bind(stores.admissionStore);
    let retentionCount = 0;
    vi.spyOn(stores.admissionStore, 'retainPendingAdmission').mockImplementation(async (input) => {
        retentionCount += 1;
        return await retainPendingAdmission(input);
    });
    const runtime = createControlRuntime(stores);

    expect((await runtime.enqueueIfAbsent(message)).status).toBe('pending-admission');
    if (state !== 'NEW') {
        const [claim] = await claimOutboundTestWork(stores, 1);
        expect(claim).toBeDefined();
        if (state === 'RETRY') {
            await releaseOutboundTestWork(stores, claim.entry, { status: 'retry' });
        }
        if (state === 'COMPLETED') {
            await releaseOutboundTestWork(stores, claim.entry, { status: 'completed' });
        }
    }

    expect((await runtime.enqueueIfAbsent(message)).status).toBe(expectedStatus);
    expect(retentionCount).toBe(1);
    expect(browserLocks.requestCount()).toBe(0);
    const retained = await readControlRows(stores);
    expect(retained.filter((entry) => entry.typeId.startsWith('AL_OUTBOUND:'))).toHaveLength(1);
    expect(retained.filter((entry) => entry.typeId === 'AL_OUTBOUND_IDENTITY')).toHaveLength(1);
    expect(retained.filter((entry) => entry.key.topicId === 'AL_OUTBOUND_MESSAGE')).toHaveLength(1);
});

it.each([
    {
        case: 'ordinary ordered data',
        message: {
            ...createOutboundMessage('ordered-data'),
            ordering: { orderingKey: 'chat', seq: 1 }
        }
    },
    {
        case: 'a control type with reliable QoS',
        message: createReliableControlMessage('spoofed-control')
    }
])('keeps $case on the serialized admission path', async ({ message }) => {
    const browserLocks = stubImmediateBrowserLock();
    const stores = createControlStores(`serialized-${message.id.msgId}`);
    await stores.admissionStore.ready();
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const runtime = createControlRuntime(stores, (event) => diagnostics.push(event));

    const result = await runtime.enqueueIfAbsent(message);

    expect(result.status).not.toBe('pending-admission');
    expect(browserLocks.requestCount()).toBe(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({
        kind: 'sender-queue-wait',
        origin: 'send'
    }));
});

it('surfaces a real terminal retention race as a retryable control handoff conflict', async () => {
    const message = createControlMessage('retention-race');
    const browserLocks = stubImmediateBrowserLock();
    const stores = createControlStores('retention-race');
    await stores.admissionStore.ready();
    const retainPendingAdmission = stores.admissionStore.retainPendingAdmission.bind(stores.admissionStore);
    vi.spyOn(stores.admissionStore, 'retainPendingAdmission').mockImplementationOnce(async (input) => {
        expect(await retainPendingAdmission(input)).toBe('pending');
        const [claim] = await claimOutboundTestWork(stores, 1);
        expect(claim).toBeDefined();
        await releaseOutboundTestWork(stores, claim.entry, { status: 'completed' });
        return await retainPendingAdmission(input);
    });
    const runtime = createControlRuntime(stores);

    await expect(runtime.enqueueIfAbsent(message)).rejects.toBeInstanceOf(RetryableConflictError);

    expect(browserLocks.requestCount()).toBe(0);
    const [owner] = (await readControlRows(stores)).filter((entry) => entry.typeId.startsWith('AL_OUTBOUND:'));
    expect(owner?.status).toBe('COMPLETED');
});

it('retries the inbound send-control owner when its durable handoff loses a retention race', async () => {
    const fixture = await createInboundControlRetryFixture();
    expect(
        (await fixture.inbound.admitIncomingMessage(
            createAcknowledgedIncomingMessage(),
            { kind: 'trusted-server' }
        )).right
    ).toMatchObject({
        kind: 'admitted'
    });
    const inboundRows = await readAllRows(fixture.inboundStores.workQueue);
    const controlOwner = inboundRows
        .filter((entry) => entry.typeId === toALInboundWorkType(fixture.inboundStores.admissionStore.namespace))
        .map((entry) => decodeALInboundWorkEntry(entry, fixture.inboundStores.admissionStore.namespace))
        .find((effect) => effect.payload.kind === 'send-control');
    if (!controlOwner) {
        throw new Error('Expected the inbound runtime to retain one send-control owner');
    }
    arrangeTerminalOutboundRetentionRace(fixture.outboundStores);

    await expect.poll(async () => {
        await fixture.queueEngine.executeOnce();
        return await fixture.inboundStores.workQueue.getItem(controlOwner.entry.key);
    }).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    expect(fixture.browserLocks.requestCount()).toBe(0);
});

interface InboundControlRetryFixture {
    readonly browserLocks: BrowserLockTrace;
    readonly inboundStores: ALInboundRuntimeStores;
    readonly outboundStores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly queueEngine: InboxOutboxEngine;
    readonly inbound: ALInboundMessageRuntime;
}

async function createInboundControlRetryFixture(): Promise<InboundControlRetryFixture> {
    const browserLocks = stubImmediateBrowserLock();
    const inboundStores = createDefaultIndexedDbALInboundRuntimeStores({
        dbName: `inbound-control-race-${crypto.randomUUID()}`,
        namespace: 'inbound-control-race',
        nowMs: () => TEST_NOW_MS
    });
    const outboundStores = createControlStores('inbound-control-race');
    await Promise.all([inboundStores.admissionStore.ready(), outboundStores.admissionStore.ready()]);
    const outbound = createControlRuntime(outboundStores);
    const queueEngine = new InboxOutboxEngine();
    const inbound = new ALInboundMessageRuntime({
        ...createDefaultALInboundRuntimeResources({
            selfPeerId: 'self',
            stores: inboundStores,
            queueEngine,
            nowMs: () => TEST_NOW_MS,
            newControlId: () => 'receipt',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        }),
        planIncomingMessage: (message, source, observations) =>
            planALMessageHandling(message, {
                ...observations,
                selfPeerId: 'self',
                fromPeerId: source.kind === 'trusted-server' ? message.id.senderId : source.peerId,
                connectedPeerIds: ['self']
            }),
        dispatchInboxEntry: async () => {},
        sendControlMessage: async (message) => {
            await outbound.enqueueIfAbsent({
                ...message,
                constraints: { ...message.constraints, expiresAtMs: TEST_NOW_MS + 5 * 60_000 }
            });
        },
        diagnostics: undefined
    });
    onTestFinished(() => inbound.dispose());
    return { browserLocks, inboundStores, outboundStores, queueEngine, inbound };
}

function arrangeTerminalOutboundRetentionRace(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>
): void {
    const retainPendingAdmission = stores.admissionStore.retainPendingAdmission.bind(stores.admissionStore);
    vi.spyOn(stores.admissionStore, 'retainPendingAdmission').mockImplementationOnce(async (input) => {
        expect(await retainPendingAdmission(input)).toBe('pending');
        const [claim] = await claimOutboundTestWork(stores, 1);
        expect(claim).toBeDefined();
        await releaseOutboundTestWork(stores, claim.entry, { status: 'completed' });
        return await retainPendingAdmission(input);
    });
}

function createAcknowledgedIncomingMessage(): ALMessage {
    return newALUnicastMessage(
        'peer',
        newALEventRoute('chat', 'self'),
        'self',
        'chat',
        { text: 'hello' },
        { ttlMs: 60_000, qos: { ack: { algo: 'hop' } } }
    );
}

function createControlMessage(msgId: string): ALMessage {
    return {
        ...newALAckControlMessage(
            { v: 2, senderId: 'self', msgId, ts: TEST_NOW_MS },
            {
                ackedMsgId: 'inbound-message',
                fromPeerId: 'self',
                toPeerId: 'peer',
                status: 'delivered',
                observedAtEpochMs: TEST_NOW_MS
            }
        ),
        constraints: { expiresAtMs: TEST_NOW_MS + 5 * 60_000 }
    };
}

function createReliableControlMessage(msgId: string): ALMessage {
    const message = createControlMessage(msgId);
    return {
        ...message,
        qos: {
            ...message.qos,
            delivery: { algo: 'at-least-once' }
        }
    };
}

function createControlStores(
    label: string,
    observer = createCountingIndexedDbOperationObserver()
): ALOutboundRuntimeStores<OutboundTestPayload> {
    return createDefaultIndexedDbALOutboundRuntimeStores({
        dbName: `outbound-control-${label}-${crypto.randomUUID()}`,
        namespace: label,
        nowMs: () => TEST_NOW_MS,
        observer,
        decodePrepared: decodeOutboundTestPayload
    });
}

function createControlRuntime(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    diagnostics?: ALOutboundRuntimeDiagnosticsSink,
    sendPreparedMessage: () => void = () => {
        throw new Error('Unexpected outbound transport');
    }
) {
    return createOutboundTestRuntimeFor({
        stores,
        queueEngine: new InboxOutboxEngine(),
        decodePreparedMessage: decodeOutboundTestPayload,
        nowMs: () => TEST_NOW_MS,
        diagnostics,
        planOutgoingMessage: (msg) => ({
            msg,
            persist: false,
            preparedMessages: [{ transport: 'ws' }]
        }),
        sendPreparedMessage: async () => {
            sendPreparedMessage();
            return { status: 'sent' };
        }
    });
}

interface BrowserLockTrace {
    readonly requestCount: () => number;
}

function stubImmediateBrowserLock(): BrowserLockTrace {
    let requestCount = 0;
    const request = async <T>(
        _name: string,
        _options: Readonly<{ mode: 'exclusive'; }>,
        callback: () => Promise<T>
    ): Promise<T> => {
        requestCount += 1;
        return await callback();
    };
    vi.stubGlobal('navigator', { locks: { request } });
    return { requestCount: () => requestCount };
}

async function readControlRows(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>
): Promise<readonly ResourceEntry[]> {
    return await readAllRows(stores.workQueue);
}

async function readAllRows(
    queue: QueueBoxResourceEntryRepository
): Promise<readonly ResourceEntry[]> {
    const entries = await Promise.all(
        (await queue.getAllKeys()).map((key) => queue.getItem(key))
    );
    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}
