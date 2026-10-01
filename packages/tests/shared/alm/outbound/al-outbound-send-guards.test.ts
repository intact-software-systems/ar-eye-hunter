import '../../../setup-browser-indexeddb.ts';

import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    holdOutboundClaims,
    runOutboundWorkTask,
    trackOutboundTestAcks
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';
import { recordIndexedDbTransactions } from '../record-indexed-db-transactions.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const GUARDS_NAMESPACE = 'send-guards';
const STATE_STORE_NAME = 'entries';

const SEND_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    persist: true,
    preparedMessages: [{ peer: 'receiver' }]
});

const SUPERSEDING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    ...SEND_PLANNER(msg, undefined),
    supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
});

const ACKED_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    ...SEND_PLANNER(msg, undefined),
    ackTracking: trackOutboundTestAcks(['receiver'])
});

function createGuardsTestStores(dbName: string): ALOutboundRuntimeStores<OutboundTestPayload> {
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName,
        storeName: STATE_STORE_NAME,
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const admissionStore = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: GUARDS_NAMESPACE,
        decodePrepared: decodeOutboundTestPayload,
        namespace: GUARDS_NAMESPACE,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { admissionStore, workQueue: backend.workQueue };
}

async function admitGuardedMessage(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage,
    planner: ALOutboundPlanner<OutboundTestPayload>
): Promise<void> {
    await store.ready();
    expect(await store.commitBundle(await computeOutboundTestAdmission(store, message, planner)))
        .toBe('committed');
}

/**
 * The read sessions a claim opens: readonly over both the state store and the work store. Work
 * probes, reservations and releases touch the work store alone.
 */
function recordAdmissionReadSessions(): () => number {
    const sessions: string[] = [];
    const openTransaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (
        this: IDBDatabase,
        storeNames: string | Iterable<string>,
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions
    ) {
        const names = typeof storeNames === 'string' ? [storeNames] : [...storeNames];
        if (
            (mode ?? 'readonly') === 'readonly' && names.includes(STATE_STORE_NAME) &&
            names.length === 2
        ) {
            sessions.push(names.join(','));
        }
        return openTransaction.call(this, storeNames, mode, options);
    });
    return () => sessions.length;
}

describe('the guards a prepared send rechecks before its carrier runs', () => {
    it('reads a first dispatch\'s supersedence and receipt from one readonly transaction', async () => {
        const { admissionStore } = createGuardsTestStores(
            `send-guards-first-${crypto.randomUUID()}`
        );
        const message = createOutboundMessage('first-dispatch');
        await admitGuardedMessage(admissionStore, message, SEND_PLANNER);

        const recorded = recordIndexedDbTransactions();
        const guards = await admissionStore.readSendGuards(message);

        expect(guards).toEqual({ kind: 'current', receiptState: undefined });
        expect(recorded.modes()).toEqual(['readonly']);
    });

    it('reads a tracked receipt beside the supersedence check in the same transaction', async () => {
        const { admissionStore } = createGuardsTestStores(
            `send-guards-receipt-${crypto.randomUUID()}`
        );
        const message = createOutboundMessage('acked-dispatch');
        await admitGuardedMessage(admissionStore, message, ACKED_PLANNER);

        const recorded = recordIndexedDbTransactions();
        const guards = await admissionStore.readSendGuards(message);

        expect(guards.kind).toBe('current');
        expect(guards.kind === 'current' ? guards.receiptState?.expectedPeerIds : undefined)
            .toEqual(['receiver']);
        expect(recorded.modes()).toEqual(['readonly']);
    });

    it('answers superseded for a replaced tracked message without reading its receipt', async () => {
        const { admissionStore } = createGuardsTestStores(
            `send-guards-superseded-${crypto.randomUUID()}`
        );
        const older = createOutboundMessage('older');
        const newer = {
            ...createOutboundMessage('newer'),
            id: { ...createOutboundMessage('newer').id, ts: older.id.ts + 1 }
        };
        await admitGuardedMessage(admissionStore, older, SUPERSEDING_PLANNER);
        await admitGuardedMessage(admissionStore, newer, SUPERSEDING_PLANNER);

        const recorded = recordIndexedDbTransactions();
        const [olderGuards, newerGuards] = [
            await admissionStore.readSendGuards(older),
            await admissionStore.readSendGuards(newer)
        ];

        expect(olderGuards).toEqual({ kind: 'superseded' });
        expect(newerGuards).toEqual({ kind: 'current', receiptState: undefined });
        expect(recorded.modes()).toEqual(['readonly', 'readonly']);
    });

    it.each(['hit', 'miss'] as const)(
        'costs a claim one guard session on a hand-off %s',
        async (handoff) => {
            const dbName = `send-guards-${handoff}-${crypto.randomUUID()}`;
            const committing = createGuardsTestStores(dbName);
            const sent: ALMessage[] = [];
            const committer = createDefaultOutboundTestRuntime({
                stores: committing,
                planOutgoingMessage: SEND_PLANNER,
                sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                    sent.push(lifecycle.canonicalMessage);
                    return { status: 'sent', submissionAttempted: true };
                }
            });
            const claims = holdOutboundClaims(committing);
            const message = createOutboundMessage(`guards-${handoff}`);
            expect((await committer.enqueueIfAbsent(message)).verdict).toMatchObject({
                kind: 'admitted',
                durable: true
            });
            await claims.release();
            if (handoff === 'miss') {
                committer.dispose();
            }
            const readSessions = recordAdmissionReadSessions();
            // A miss: a restarted runtime over the same database claims what the first one committed.
            const claimant = handoff === 'hit' ? committer : createDefaultOutboundTestRuntime({
                stores: createGuardsTestStores(dbName),
                planOutgoingMessage: SEND_PLANNER,
                sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                    sent.push(lifecycle.canonicalMessage);
                    return { status: 'sent', submissionAttempted: true };
                }
            });

            await claimant.ready();
            await runOutboundWorkTask(claimant);

            expect(sent).toEqual([message]);
            expect(
                readSessions(),
                'one guard session, and the canonical read before it only on a miss'
            )
                .toBe(handoff === 'hit' ? 1 : 2);
        }
    );
});
