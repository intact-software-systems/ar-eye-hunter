import { afterEach, expect, it, vi } from 'vitest';

import { AL_CONTROL_ACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import '../../setup-browser-indexeddb.ts';
import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload } from './outbound-test-payload.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

type CommitPhasesEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'commit-phases'; }>;
type SenderQueueWaitEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'sender-queue-wait'; }>;
type ControlAdmissionEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'control-admission'; }>;

/** The admission read chain a first send walks: client record, stored message, canonical pair, control. */
const FIRST_SEND_READ_OPERATIONS = 9;

function createStores(kind: 'memory' | 'indexeddb') {
    const backend = kind === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `outbound-commit-phases-${crypto.randomUUID()}`,
            storeName: 'entries',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
    const admissionStore = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'outbound-commit-phases',
        decodePrepared: decodeOutboundTestPayload,
        namespace: 'outbound-commit-phases',
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { admissionStore, workQueue: backend.workQueue };
}

function commitPhasesOf(
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]
): readonly CommitPhasesEvent[] {
    return diagnostics.filter((event): event is CommitPhasesEvent => event.kind === 'commit-phases');
}

function controlAdmissionsOf(
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]
): readonly ControlAdmissionEvent[] {
    return diagnostics.filter((event): event is ControlAdmissionEvent => event.kind === 'control-admission');
}

function senderQueueWaitsOf(
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]
): readonly SenderQueueWaitEvent[] {
    return diagnostics.filter((event): event is SenderQueueWaitEvent => event.kind === 'sender-queue-wait');
}

it.each(['memory', 'indexeddb'] as const)(
    'splits a send admission into its read chain and its write transaction over %s',
    async (kind) => {
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createStores(kind),
            diagnostics: (event) => diagnostics.push(event),
            planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, persist: true, preparedMessages: [{ kind: 'send' }] }),
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
        });

        const message = createOutboundMessage('msg-commit-phases');
        const enqueued = await runtime.enqueueIfAbsent(message);

        expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: true });
        const [phases] = commitPhasesOf(diagnostics);
        expect(phases).toMatchObject({
            kind: 'commit-phases',
            senderId: 'self',
            // The message and its lane, so a readiness timeout can name which send stalled.
            msgId: message.id.msgId,
            typeId: 'chat.private-text.v1',
            origin: 'send',
            readOperationCount: FIRST_SEND_READ_OPERATIONS,
            commitOutcome: 'committed'
        });
        expect(phases?.readDurationMs).toBeGreaterThanOrEqual(0);
        expect(phases?.commitDurationMs).toBeGreaterThanOrEqual(0);
        expect(senderQueueWaitsOf(diagnostics)[0]).toMatchObject({
            origin: 'send',
            queued: false,
            queuedBehindOrigin: 'none'
        });
        expect(diagnostics.filter((event) => event.kind === 'browser-lock-hold')[0]).toMatchObject({
            origin: 'send'
        });
        runtime.dispose();
    }
);

it('charges the drain its own commit rather than leaving it on the next send', async () => {
    const stores = createStores('memory');
    const store = stores.admissionStore;
    const competitor = await computeOutboundTestAdmission(store, createOutboundMessage('competing-sender-version'));
    const commitBundle = store.commitBundle.bind(store);
    let contested = false;
    // A competing sender wins the version fence inside the first commit, so the send below is told
    // its bundle conflicted and retains a pending admission the drain must admit on its own.
    vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle) => {
        if (!contested) {
            contested = true;
            expect(await commitBundle(competitor)).toBe('committed');
        }
        return await commitBundle(bundle);
    });
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const engine = new InboxOutboxEngine();
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        queueEngine: engine,
        diagnostics: (event) => diagnostics.push(event),
        planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, persist: false, preparedMessages: [{ kind: 'send' }] }),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
    });

    const pending = await runtime.enqueueIfAbsent(createOutboundMessage('msg-drain-origin', { ttlMs: 30_000 }));

    expect(pending.verdict).toEqual({ kind: 'pending' });
    await expect.poll(async () => {
        await engine.executeOnce();
        return commitPhasesOf(diagnostics).filter((event) => event.origin === 'drain').length;
    }).toBeGreaterThan(0);
    const [drained] = commitPhasesOf(diagnostics).filter((event) => event.origin === 'drain');
    expect(drained).toMatchObject({
        origin: 'drain',
        commitOutcome: 'committed',
        msgId: pending.message.id.msgId,
        typeId: 'chat.private-text.v1'
    });
    expect(drained?.readOperationCount).toBeGreaterThan(0);
    expect(senderQueueWaitsOf(diagnostics).map((event) => event.origin)).toContain('drain');
    runtime.dispose();
});

it('names the origin a queued send waited behind', async () => {
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores: createStores('memory'),
        diagnostics: (event) => diagnostics.push(event),
        planOutgoingMessage: (msg) => ({ msg, dropReasonCode: undefined, persist: false, preparedMessages: [{ kind: 'send' }] }),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
    });

    const [first, second] = await Promise.all([
        runtime.enqueueIfAbsent(createOutboundMessage('msg-queued-first')),
        runtime.enqueueIfAbsent(createOutboundMessage('msg-queued-second'))
    ]);

    for (const result of [first, second]) {
        expect(result.verdict).toMatchObject({ kind: 'admitted', durable: false });
    }
    expect(
        senderQueueWaitsOf(diagnostics).map((event) => ({
            origin: event.origin,
            queued: event.queued,
            queuedBehindOrigin: event.queuedBehindOrigin
        }))
    ).toEqual([
        { origin: 'send', queued: false, queuedBehindOrigin: 'none' },
        { origin: 'send', queued: true, queuedBehindOrigin: 'send' }
    ]);
    runtime.dispose();
});

it.each(['memory', 'indexeddb'] as const)(
    'records the control admission verdict every carrier discards, with a rejection\'s reason, over %s',
    async (kind) => {
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createStores(kind),
            diagnostics: (event) => diagnostics.push(event),
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                persist: true,
                preparedMessages: [{ kind: 'send' }],
                ackTracking: { enabled: true, timeoutMs: 60_000, maxAttempts: 3, expectedPeerIds: ['peer-1'], nextHopPeerIds: ['peer-1'], mode: 'hop' }
            }),
            sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
        });
        const message = createOutboundMessage('msg-control-verdict');
        await runtime.enqueueIfAbsent(message);

        for (const fromPeerId of ['peer-1', 'peer-2']) {
            await runtime.acceptControlMessage(
                newALAckControlMessage(
                    { v: 2, msgId: `control-${fromPeerId}`, ts: 1, senderId: fromPeerId },
                    {
                        ackedMsgId: message.id.msgId,
                        originPeerId: 'self',
                        logicalRecipientPeerId: fromPeerId,
                        fromPeerId,
                        toPeerId: 'self',
                        status: 'accepted',
                        observedAtEpochMs: 1,
                        carrier: 'ws'
                    }
                ),
                'peer'
            );
        }

        const verdict = { kind: 'control-admission', typeId: AL_CONTROL_ACK_TYPE_ID, targetMsgId: message.id.msgId };
        expect(controlAdmissionsOf(diagnostics)).toEqual([
            { ...verdict, msgId: 'control-peer-1', outcome: 'committed', reason: 'none' },
            {
                ...verdict,
                msgId: 'control-peer-2',
                outcome: 'rejected',
                reason: 'AL acknowledgement confirms no peer of the pending outbound receipt'
            }
        ]);
        runtime.dispose();
    }
);
