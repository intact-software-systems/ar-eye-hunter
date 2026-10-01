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
import { createDefaultIndexedDbALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    ALStorageResetListeners,
    openIndexedDbAdmissionDatabase,
    type ALStorageResetEvent
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import {
    AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT,
    ALOutboundCanonicalHandoff
} from '@shared/alm/outbound/lane/al-outbound-canonical-handoff.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createIndexedDbOutboundTestStores,
    createOutboundMessage,
    createRecordingOutboundTestRuntime,
    createVolatileOutboundTestStores,
    holdOutboundClaims,
    OUTBOUND_TEST_SEND_PLANNER,
    runOutboundWorkTask
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const HANDOFF_NAMESPACE = 'canonical-handoff';

interface HandoffTestPair {
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly counting: CountingIndexedDbOperationObserver;
}

/** One tab's view of a shared database: its own connection, store and operation counts. */
function openHandoffTestPair(
    dbName: string,
    storageResets?: ALStorageResetListeners
): HandoffTestPair {
    const counting = createCountingIndexedDbOperationObserver();
    const stores = createIndexedDbOutboundTestStores({
        observer: counting,
        namespace: HANDOFF_NAMESPACE,
        dbName,
        storageResets
    });
    return { stores, counting };
}

describe('the canonical hand-off bound', () => {
    it('keeps the newest committed sends up to its limit and gives each one up once', async () => {
        const store = createDefaultOutboundTestStores().admissionStore;
        const peers = Array.from(
            { length: AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT + 1 },
            (_, index) => ({ peer: `p${index}` })
        );
        const bundle = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('bounded'),
            (msg) => ({ msg, dropReasonCode: undefined, persist: true, preparedMessages: peers })
        );
        const sends = bundle.durableEffects.filter((effect) => effect.payload.kind === 'send-prepared');
        expect(sends).toHaveLength(AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT + 1);
        const handoff = new ALOutboundCanonicalHandoff({
            namespace: store.namespace,
            limit: AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT
        });

        handoff.setCommitted(bundle);

        const oldest = toALOutboundWorkKey(store.namespace, sends[0]!.effectId);
        const newest = toALOutboundWorkKey(store.namespace, sends.at(-1)!.effectId);
        expect(handoff.takeCanonical(oldest), 'the oldest send past the limit is dropped')
            .toBeUndefined();
        expect(handoff.takeCanonical(newest)).toBe(bundle.canonicalEntry);
        expect(handoff.takeCanonical(newest), 'a claim consumes what it was handed')
            .toBeUndefined();
    });

    it('holds nothing after it is cleared', async () => {
        const store = createDefaultOutboundTestStores().admissionStore;
        const bundle = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('cleared'),
            OUTBOUND_TEST_SEND_PLANNER
        );
        const [send] = bundle.durableEffects;
        const handoff = new ALOutboundCanonicalHandoff({ namespace: store.namespace, limit: 4 });
        handoff.setCommitted(bundle);

        handoff.clear();

        expect(handoff.takeCanonical(toALOutboundWorkKey(store.namespace, send!.effectId)))
            .toBeUndefined();
    });
});

describe('the committed canonical message handed to dispatch', () => {
    it('reaches the claim of the tab that committed it without reading the canonical pair back', async () => {
        const { stores, counting } = openHandoffTestPair(`handoff-hit-${crypto.randomUUID()}`);
        const sent: ALMessage[] = [];
        const runtime = createRecordingOutboundTestRuntime(stores, sent);
        const claims = holdOutboundClaims(stores);
        const message = createOutboundMessage('handoff-hit');
        expect((await runtime.enqueueIfAbsent(message)).verdict).toMatchObject({
            kind: 'admitted',
            durable: true
        });
        counting.reset();
        await claims.release();

        await runOutboundWorkTask(runtime);

        expect(sent).toEqual([message]);
        expect(
            counting.getCounts().byKind['work-read'] ?? 0,
            'a hit reads neither canonical nor identity row'
        ).toBe(0);
        runtime.dispose();
    });

    it.each(['another tab', 'a reload'] as const)(
        'is read back when %s claims the committed row',
        async (claimant) => {
            const dbName = `handoff-miss-${crypto.randomUUID()}`;
            const committing = openHandoffTestPair(dbName);
            const committer = createRecordingOutboundTestRuntime(committing.stores, []);
            // The committing tab never claims: only the claimant below can send the row.
            const claims = holdOutboundClaims(committing.stores);
            const message = createOutboundMessage('handoff-miss');
            expect((await committer.enqueueIfAbsent(message)).verdict).toMatchObject({
                kind: 'admitted',
                durable: true
            });
            if (claimant === 'a reload') {
                committer.dispose();
            }
            const claiming = openHandoffTestPair(dbName);
            const sent: ALMessage[] = [];
            const runtime = createRecordingOutboundTestRuntime(claiming.stores, sent);

            await runtime.ready();
            await runOutboundWorkTask(runtime);

            expect(sent).toEqual([message]);
            expect(
                claiming.counting.getCounts().byKind['work-read'],
                'a miss reads the canonical pair'
            ).toBe(2);
            await claims.release();
        }
    );

    it('sends the stored canonical message when its lane replays a retained pending admission', async () => {
        const { stores } = openHandoffTestPair(`handoff-replay-${crypto.randomUUID()}`);
        const store = stores.admissionStore;
        const competitor = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('competing-sender-version')
        );
        const commit = store.commitBundle.bind(store);
        let first = true;
        // A competing commit wins the sender version inside the first commit, so the send below is
        // retained as a pending admission and replayed by the lane's own work.
        vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle) => {
            if (first) {
                first = false;
                expect(await commit(competitor)).toBe('committed');
            }
            return await commit(bundle);
        });
        const engine = new InboxOutboxEngine();
        const sent: ALMessage[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            queueEngine: engine,
            planOutgoingMessage: OUTBOUND_TEST_SEND_PLANNER,
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                sent.push(lifecycle.canonicalMessage);
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const message = createOutboundMessage('handoff-replay');

        // The replay commits through dispatch admission, not the lane's own commit, so the send's
        // claim finds nothing handed over and reads the canonical pair.
        expect((await runtime.enqueueIfAbsent(message)).verdict).toEqual({ kind: 'pending' });
        await expect.poll(async () => {
            await engine.executeOnce();
            return sent;
        }).toEqual([message]);
        runtime.dispose();
    });

    it('is dropped when the storage of its pair is reset', async () => {
        const storageResets = new ALStorageResetListeners();
        const { stores, counting } = openHandoffTestPair(
            `handoff-reset-${crypto.randomUUID()}`,
            storageResets
        );
        const sent: ALMessage[] = [];
        const runtime = createRecordingOutboundTestRuntime(stores, sent);
        const claims = holdOutboundClaims(stores);
        const message = createOutboundMessage('handoff-reset');
        expect((await runtime.enqueueIfAbsent(message)).verdict).toMatchObject({
            kind: 'admitted',
            durable: true
        });

        storageResets.notify({
            dbName: 'handoff-reset',
            previousSchemaId: undefined,
            schemaId: AL_ADMISSION_SCHEMA_ID,
            reason: 'store-schema-mismatch'
        });
        counting.reset();
        await claims.release();
        await runOutboundWorkTask(runtime);

        expect(sent).toEqual([message]);
        expect(
            counting.getCounts().byKind['work-read'],
            'the claim after a reset reads the canonical pair'
        ).toBe(2);
        runtime.dispose();
    });

    it('is dropped when its runtime is disposed', async () => {
        const { stores } = openHandoffTestPair(`handoff-dispose-${crypto.randomUUID()}`);
        const setCommitted = vi.spyOn(ALOutboundCanonicalHandoff.prototype, 'setCommitted');
        const runtime = createRecordingOutboundTestRuntime(stores, []);
        const claims = holdOutboundClaims(stores);
        for (const resourceId of ['held-until-dispose', 'dropped-by-dispose']) {
            expect((await runtime.enqueueIfAbsent(createOutboundMessage(resourceId))).verdict)
                .toMatchObject({ kind: 'admitted', durable: true });
        }
        // The durable lane's own hand-off, and the work slot of each send it was handed.
        const [handoff] = setCommitted.mock.contexts as ALOutboundCanonicalHandoff[];
        const [held, dropped] = setCommitted.mock.calls.map(([bundle]) =>
            toALOutboundWorkKey(stores.admissionStore.namespace, bundle.durableEffects[0]!.effectId)
        );
        expect(handoff!.takeCanonical(held!), 'held while the runtime lives').toBeDefined();

        runtime.dispose();

        expect(handoff!.takeCanonical(dropped!)).toBeUndefined();
        await claims.release();
    });

    it('tells the lane of an IndexedDB pair when its database is reset on open', async () => {
        const dbName = `handoff-reset-open-${crypto.randomUUID()}`;
        const stale = await openIndexedDbAdmissionDatabase({
            dbName,
            storeName: 'entries',
            schemaId: 'rallar-alm-previous-schema',
            onStorageReset: () => {}
        });
        stale.close();
        const reported: ALStorageResetEvent[] = [];
        const stores = createDefaultIndexedDbALOutboundRuntimeStores({
            dbName,
            decodePrepared: decodeOutboundTestPayload,
            onStorageReset: (event) => reported.push(event)
        });
        const heard: ALStorageResetEvent[] = [];
        stores.storageResets?.add((event) => heard.push(event));

        await stores.admissionStore.ready();

        expect(reported).toHaveLength(1);
        expect(heard).toEqual(reported);
    });

    it('is not used for a row past its deadline: the claim reads storage and drops the work', async () => {
        // One fake clock for the owner, both stores and Date.now: the guard reads the stores' clock.
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
        const { stores, counting } = openHandoffTestPair(`handoff-deadline-${crypto.randomUUID()}`);
        const settlements: ALDeliverySettlement[] = [];
        const sent: ALMessage[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            settlements: (settlement) => settlements.push(settlement),
            planOutgoingMessage: OUTBOUND_TEST_SEND_PLANNER,
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                sent.push(lifecycle.canonicalMessage);
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const claims = holdOutboundClaims(stores);
        const message = createOutboundMessage('handoff-deadline', { ttlMs: 1_000 });
        expect((await runtime.enqueueIfAbsent(message)).verdict).toMatchObject({
            kind: 'admitted',
            durable: true
        });
        const settledBefore = settlements.length;
        const readWorkSnapshot = stores.admissionStore.readWorkSnapshot.bind(stores.admissionStore);
        vi.spyOn(stores.admissionStore, 'readWorkSnapshot').mockImplementation(async (entry, handedOff) => {
            // The claim crosses the deadline after its reservation and before its read.
            vi.setSystemTime(Date.now() + 5_000);
            return await readWorkSnapshot(entry, handedOff);
        });

        counting.reset();
        await claims.release();
        await runOutboundWorkTask(runtime);

        expect(sent).toEqual([]);
        expect(
            counting.getCounts().byKind['work-read'],
            'past the deadline the claim reads the canonical pair, as without a hand-off'
        ).toBe(2);
        expect(
            settlements.slice(settledBefore),
            'the expired pair reads as absent and the work is dropped: no attempt, no expiry'
        ).toEqual([]);
    });

    it('rejects a held row that does not match the claimed work row as corruption and never sends it', async () => {
        const { stores } = openHandoffTestPair(`handoff-mismatch-${crypto.randomUUID()}`);
        const sent: ALMessage[] = [];
        const runtime = createRecordingOutboundTestRuntime(stores, sent);
        const claims = holdOutboundClaims(stores);
        expect((await runtime.enqueueIfAbsent(createOutboundMessage('handoff-mismatch'))).verdict)
            .toMatchObject({ kind: 'admitted', durable: true });
        const other = await computeOutboundTestAdmission(
            stores.admissionStore,
            createOutboundMessage('handoff-other-message'),
            OUTBOUND_TEST_SEND_PLANNER
        );
        vi.spyOn(ALOutboundCanonicalHandoff.prototype, 'takeCanonical')
            .mockReturnValue(other.canonicalEntry);
        const readWorkSnapshot = vi.spyOn(stores.admissionStore, 'readWorkSnapshot');

        await claims.release();
        await runOutboundWorkTask(runtime);

        expect(sent).toEqual([]);
        expect(readWorkSnapshot).toHaveBeenCalledTimes(1);
        await expect(readWorkSnapshot.mock.results[0]!.value).rejects.toBeInstanceOf(
            ALAdmissionCorruptionError
        );
    });

    it('holds the canonical row of every member a group commit wrote', async () => {
        const { stores, counting } = openHandoffTestPair(`handoff-group-${crypto.randomUUID()}`);
        const setCommitted = vi.spyOn(ALOutboundCanonicalHandoff.prototype, 'setCommitted');
        const sent: ALMessage[] = [];
        const runtime = createRecordingOutboundTestRuntime(stores, sent);
        const claims = holdOutboundClaims(stores);
        const members = [createOutboundMessage('handoff-group-a'), createOutboundMessage('handoff-group-b')];

        const results = await runtime.enqueueAllIfAbsent(members);

        expect(results.map((result) => result.verdict)).toMatchObject([
            { kind: 'admitted', durable: true },
            { kind: 'admitted', durable: true }
        ]);
        expect(
            setCommitted.mock.calls.map(([bundle]) => bundle.canonicalEntry?.key),
            'one hand-off per committed member'
        ).toEqual(members.map((member) => toALOutboundCanonicalKey(HANDOFF_NAMESPACE, member)));
        counting.reset();
        await claims.release();
        await runOutboundWorkTask(runtime);
        expect(sent).toHaveLength(2);
        expect(sent).toEqual(expect.arrayContaining(members));
        expect(
            counting.getCounts().byKind['work-read'] ?? 0,
            'both claims take their member\'s canonical row in memory'
        ).toBe(0);
    });

    it('is not kept by the volatile lane', async () => {
        const setCommitted = vi.spyOn(ALOutboundCanonicalHandoff.prototype, 'setCommitted');
        const sent: ALMessage[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            volatileStores: createVolatileOutboundTestStores(),
            planOutgoingMessage: (msg) => ({ ...OUTBOUND_TEST_SEND_PLANNER(msg, undefined), persist: false }),
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                sent.push(lifecycle.canonicalMessage);
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const message = createOutboundMessage('handoff-volatile');

        expect((await runtime.enqueueIfAbsent(message)).verdict).toMatchObject({
            kind: 'admitted',
            durable: false
        });
        await vi.waitFor(() => expect(sent).toEqual([message]));

        expect(setCommitted, 'the memory pair\'s lane has no hand-off to record into').not.toHaveBeenCalled();
    });
});
