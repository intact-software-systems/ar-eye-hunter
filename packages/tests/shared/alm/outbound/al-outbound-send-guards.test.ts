import '../../../setup-browser-indexeddb.ts';

import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { toALOutboundPendingAckKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    computeOutboundTestAdmission,
    createIndexedDbOutboundTestStores,
    createOutboundMessage,
    createRecordingOutboundTestRuntime,
    holdOutboundClaims,
    OUTBOUND_TEST_SEND_PLANNER,
    runOutboundWorkTask,
    trackOutboundTestAcks
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';
import { recordIndexedDbTransactions } from '../record-indexed-db-transactions.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

const GUARDS_NAMESPACE = 'send-guards';
const STATE_STORE_NAME = 'entries';

const SUPERSEDING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    ...OUTBOUND_TEST_SEND_PLANNER(msg, undefined),
    supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
});

const ACKED_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    ...OUTBOUND_TEST_SEND_PLANNER(msg, undefined),
    ackTracking: trackOutboundTestAcks(['receiver'])
});

function createGuardsTestStores(dbName: string): ALOutboundRuntimeStores<OutboundTestPayload> {
    return createIndexedDbOutboundTestStores({
        observer: createPassThroughIndexedDbOperationObserver(),
        namespace: GUARDS_NAMESPACE,
        dbName
    });
}

/** Writes a row the receipt decoder rejects straight into the state store, past every admission check. */
async function writeCorruptReceiptRow(dbName: string, message: ALMessage): Promise<void> {
    const key = toALOutboundPendingAckKey({
        namespace: GUARDS_NAMESPACE,
        originPeerId: message.id.senderId,
        msgId: message.id.msgId
    });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STATE_STORE_NAME, 'readwrite');
        transaction.objectStore(STATE_STORE_NAME).put({
            key,
            value: 'not a receipt',
            writeToken: 'corrupt',
            expireAtTimestamp: Date.now() + 60_000
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
    db.close();
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
        await admitGuardedMessage(admissionStore, message, OUTBOUND_TEST_SEND_PLANNER);

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
        const dbName = `send-guards-superseded-${crypto.randomUUID()}`;
        const { admissionStore } = createGuardsTestStores(dbName);
        const older = createOutboundMessage('older');
        const newer = {
            ...createOutboundMessage('newer'),
            id: { ...createOutboundMessage('newer').id, ts: older.id.ts + 1 }
        };
        await admitGuardedMessage(admissionStore, older, SUPERSEDING_PLANNER);
        await admitGuardedMessage(admissionStore, newer, SUPERSEDING_PLANNER);
        // A read of the older message's receipt would throw, so only a skipped read answers.
        await writeCorruptReceiptRow(dbName, older);
        await expect(
            admissionStore.readReceiptState({ originPeerId: older.id.senderId, msgId: older.id.msgId })
        ).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

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
            const committer = createRecordingOutboundTestRuntime(committing, sent);
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
            const claimant = handoff === 'hit'
                ? committer
                : createRecordingOutboundTestRuntime(createGuardsTestStores(dbName), sent);

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
