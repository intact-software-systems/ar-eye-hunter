import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createDefaultIndexedDbALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { RetryableConflictError } from '@shared/resilience/try-with-policy.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import '../../setup-browser-indexeddb.ts';
import {
    claimOutboundTestWork,
    createOutboundMessage,
    createOutboundTestRuntimeFor,
    holdOutboundClaims,
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

it('commits initial control ownership without waiting for outbound serialization', async () => {
    const message = createControlMessage('control-handoff');
    const browserLocks = stubImmediateBrowserLock();
    const observer = createCountingIndexedDbOperationObserver();
    const stores = createDefaultControlStores({ label: 'control-handoff', observer });
    await stores.admissionStore.ready();
    observer.reset();
    const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
    let admissionMetadataCommitCount = 0;
    vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
        admissionMetadataCommitCount += 1;
        return await commitBundle(bundle);
    });
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const runtime = createDefaultControlRuntime({ stores: stores, diagnostics: (event) => diagnostics.push(event) });

    const result = await runtime.enqueueIfAbsent(message);

    expect(result.verdict.kind).toBe('admitted');
    expect(admissionMetadataCommitCount).toBe(1);
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
    const dbName = `outbound-control-concurrent-handoff-${crypto.randomUUID()}`;
    const firstStores = createDefaultControlStores({ label: 'concurrent-handoff', dbName });
    const secondStores = createDefaultControlStores({ label: 'concurrent-handoff', dbName });
    await Promise.all([firstStores.admissionStore.ready(), secondStores.admissionStore.ready()]);
    vi.spyOn(firstStores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
    vi.spyOn(secondStores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
    expect(firstStores.admissionStore).not.toBe(secondStores.admissionStore);
    expect(firstStores.workQueue).not.toBe(secondStores.workQueue);
    let transportCount = 0;
    const first = createDefaultControlRuntime({ stores: firstStores, diagnostics: undefined, sendPreparedMessage: () => transportCount += 1 });
    const second = createDefaultControlRuntime({ stores: secondStores, diagnostics: undefined, sendPreparedMessage: () => transportCount += 1 });
    // The commits' own batches claim nothing, so the counts below are the hand-off's alone.
    const firstHeldClaims = holdOutboundClaims(firstStores);
    const secondHeldClaims = holdOutboundClaims(secondStores);

    const results = await Promise.all([
        first.enqueueIfAbsent(message),
        second.enqueueIfAbsent(message)
    ]);

    expect(results.map((result) => result.verdict.kind)).toEqual(['pending', 'pending']);
    const retained = await readAllRows(firstStores.workQueue);
    expect(retained.filter((entry) => entry.typeId.startsWith('AL_OUTBOUND:'))).toHaveLength(1);
    expect(retained.filter((entry) => entry.typeId === 'AL_OUTBOUND_IDENTITY')).toHaveLength(1);
    expect(retained.filter((entry) => entry.key.topicId === 'AL_OUTBOUND_MESSAGE')).toHaveLength(1);
    expect(browserLocks.requestCount()).toBe(0);
    await Promise.all([firstHeldClaims.release(first), secondHeldClaims.release(second)]);

    for (let pass = 0; pass < 3; pass += 1) {
        await runOutboundWorkTask(first);
        await runOutboundWorkTask(second);
    }

    expect(transportCount).toBe(1);
    expect(browserLocks.requestCount()).toBe(1);
    expect((await second.enqueueIfAbsent(message)).verdict.kind).toBe('duplicate');
    expect(transportCount).toBe(1);
});

it.each(
    [
        { state: 'NEW', expectedStatus: 'pending' },
        { state: 'RESERVED', expectedStatus: 'pending' },
        { state: 'RETRY', expectedStatus: 'pending' },
        { state: 'COMPLETED', expectedStatus: 'skipped' }
    ] as const
)('does not duplicate a $state control handoff owner', async ({ state, expectedStatus }) => {
    const message = createControlMessage(`repeated-${state.toLowerCase()}`);
    const browserLocks = stubImmediateBrowserLock();
    const stores = createDefaultControlStores({ label: `repeated-${state.toLowerCase()}` });
    await stores.admissionStore.ready();
    vi.spyOn(stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
    const retainPendingAdmission = stores.admissionStore.retainPendingAdmission.bind(stores.admissionStore);
    let retentionCount = 0;
    vi.spyOn(stores.admissionStore, 'retainPendingAdmission').mockImplementation(async (input) => {
        retentionCount += 1;
        return await retainPendingAdmission(input);
    });
    const runtime = createDefaultControlRuntime({ stores: stores });
    // The pending row's own batch must not race the claim this case makes in its place.
    const heldClaims = holdOutboundClaims(stores);

    expect((await runtime.enqueueIfAbsent(message)).verdict.kind).toBe('pending');
    await heldClaims.release(runtime);
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

    expect((await runtime.enqueueIfAbsent(message)).verdict.kind).toBe(expectedStatus);
    expect(retentionCount).toBe(1);
    expect(browserLocks.requestCount()).toBe(0);
    const retained = await readAllRows(stores.workQueue);
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
    const stores = createDefaultControlStores({ label: `serialized-${message.id.msgId}` });
    await stores.admissionStore.ready();
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const runtime = createDefaultControlRuntime({ stores: stores, diagnostics: (event) => diagnostics.push(event) });

    const result = await runtime.enqueueIfAbsent(message);

    expect(result.verdict.kind).not.toBe('pending');
    expect(browserLocks.requestCount()).toBe(1);
    expect(diagnostics).toContainEqual(expect.objectContaining({
        kind: 'sender-queue-wait',
        origin: 'send'
    }));
});

it('surfaces a real terminal retention race as a retryable control handoff conflict', async () => {
    const message = createControlMessage('retention-race');
    const browserLocks = stubImmediateBrowserLock();
    const stores = createDefaultControlStores({ label: 'retention-race' });
    await stores.admissionStore.ready();
    vi.spyOn(stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
    const retainPendingAdmission = stores.admissionStore.retainPendingAdmission.bind(stores.admissionStore);
    vi.spyOn(stores.admissionStore, 'retainPendingAdmission').mockImplementationOnce(async (input) => {
        expect(await retainPendingAdmission(input)).toBe('pending');
        const [claim] = await claimOutboundTestWork(stores, 1);
        expect(claim).toBeDefined();
        await releaseOutboundTestWork(stores, claim.entry, { status: 'completed' });
        return await retainPendingAdmission(input);
    });
    const runtime = createDefaultControlRuntime({ stores: stores });

    await expect(runtime.enqueueIfAbsent(message)).rejects.toBeInstanceOf(RetryableConflictError);

    expect(browserLocks.requestCount()).toBe(0);
    const [owner] = (await readAllRows(stores.workQueue)).filter((entry) => entry.typeId.startsWith('AL_OUTBOUND:'));
    expect(owner?.status).toBe('COMPLETED');
});

it('settles every control handoff before rejecting a batch and wakes its late retained member', async () => {
    const stores = createDefaultControlStores({ label: 'batch-settlement' });
    await stores.admissionStore.ready();
    vi.spyOn(stores.admissionStore, 'commitBundles').mockResolvedValueOnce('conflict');
    vi.spyOn(stores.admissionStore, 'commitBundle')
        .mockResolvedValueOnce('conflict').mockResolvedValueOnce('conflict');
    const laterEntered = Promise.withResolvers<void>();
    const releaseLater = Promise.withResolvers<void>();
    const retain = stores.admissionStore.retainPendingAdmission.bind(stores.admissionStore);
    let retained = false;
    vi.spyOn(stores.admissionStore, 'retainPendingAdmission').mockImplementation(async (input) => {
        if (input.payload.kind === 'admit-message' && input.payload.message.msgId === 'failed-control') {
            throw new RetryableConflictError('First control retention failed');
        }
        laterEntered.resolve();
        await releaseLater.promise;
        const result = await retain(input);
        retained = true;
        return result;
    });
    let transports = 0;
    const engine = new InboxOutboxEngine();
    const runtime = createDefaultControlRuntime({ stores: stores, diagnostics: undefined, sendPreparedMessage: () => transports += 1, queueEngine: engine });
    await runtime.ready();
    engine.start();
    onTestFinished(() => engine.stop());
    const rejected = runtime.enqueueAllIfAbsent([
        createControlMessage('failed-control'),
        createControlMessage('late-control')
    ]).then(
        () => ({ error: undefined, retainedAtSettlement: retained }),
        (error: unknown) => ({ error: toError(error), retainedAtSettlement: retained })
    );
    await laterEntered.promise;
    releaseLater.resolve();

    const settlement = await rejected;
    expect(settlement.error).toBeInstanceOf(RetryableConflictError);
    expect(settlement.retainedAtSettlement).toBe(true);
    // No extra engine wake: the batch's own settlement must announce its successful member.
    await expect.poll(() => transports).toBe(1);
});

function createControlMessage(msgId: string): ALMessage {
    return {
        ...newALAckControlMessage(
            { v: 4, senderId: 'self', msgId, ts: TEST_NOW_MS, traceId: 'trace-outbound-control-handoff' },
            {
                ackedMsgId: 'inbound-message',
                fromPeerId: 'self',
                toPeerId: 'peer',
                originPeerId: 'peer',
                logicalRecipientPeerId: 'self',
                carrier: 'ws',
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

interface CreateDefaultControlStoresInput {
    readonly label: string;
    readonly dbName?: string;
    readonly observer?: IndexedDbOperationObserver;
}

function createDefaultControlStores(input: CreateDefaultControlStoresInput): ALOutboundRuntimeStores<OutboundTestPayload> {
    return createDefaultIndexedDbALOutboundRuntimeStores({
        dbName: input.dbName ?? `outbound-control-${input.label}-${crypto.randomUUID()}`,
        namespace: input.label,
        nowMs: () => TEST_NOW_MS,
        observer: input.observer,
        decodePrepared: decodeOutboundTestPayload
    });
}

interface CreateDefaultControlRuntimeInput {
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly diagnostics?: ALOutboundRuntimeDiagnosticsSink;
    readonly sendPreparedMessage?: () => void;
    readonly queueEngine?: InboxOutboxEngine;
}

function createDefaultControlRuntime(
    input: CreateDefaultControlRuntimeInput
): ALOutboundMessageRuntime<OutboundTestPayload> {
    const sendPreparedMessage = input.sendPreparedMessage ?? (() => {
        throw new Error('Unexpected outbound transport');
    });
    return createOutboundTestRuntimeFor({
        stores: input.stores,
        queueEngine: input.queueEngine ?? new InboxOutboxEngine(),
        decodePreparedMessage: decodeOutboundTestPayload,
        nowMs: () => TEST_NOW_MS,
        diagnostics: input.diagnostics,
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'volatile',
            preparedMessages: [{ transport: 'ws' }],
            admittedConnectionGenerationIds: undefined
        }),
        sendPreparedMessage: async () => {
            sendPreparedMessage();
            return { status: 'sent', submissionAttempted: true };
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

async function readAllRows(
    queue: QueueBoxResourceEntryRepository
): Promise<readonly ResourceEntry[]> {
    const entries = await Promise.all(
        (await queue.getAllKeys()).map((key) => queue.getItem(key))
    );
    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}
