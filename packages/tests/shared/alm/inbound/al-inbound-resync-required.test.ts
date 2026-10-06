import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOrderingObservation } from '@shared/al-contracts/al-runtime.ts';
import {
    toALInboundResyncCursor,
    type ALInboundResyncRequired
} from '@shared/alm/inbound/al-inbound-resync-required.ts';
import {
    decodeALInboundWorkEntry,
    type ALPersistedInboundEffect
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SENDER_PEER_ID,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from '../inbound-runtime-test-fixture.ts';

const RESYNC_GAP_SEQ = 300;

interface ResyncRuntime {
    readonly fixture: InboundTestRuntime;
    readonly resyncs: ALInboundResyncRequired[];
    /** The work rows the store held the moment each resync reached the sink: what had committed before the owner heard. */
    readonly workAtResync: (readonly ALPersistedInboundEffect[])[];
    readonly admissions: Awaited<ReturnType<InboundTestRuntime['runtime']['admitIncomingMessage']>>[];
    admit(msg: ALMessage): Promise<void>;
}

function toResyncRequiredObservation(msg: ALMessage, lastContiguousSeq: number): ALOrderingObservation {
    return {
        status: 'resync-required',
        trackKey: `${msg.ordering!.orderingKey}:${msg.id.senderId}:0`,
        seq: msg.ordering!.seq,
        expectedSeq: lastContiguousSeq + 1,
        lastContiguousSeq,
        missingRanges: [],
        releasableSeqs: []
    };
}

/**
 * The fixture runtime with a recovery sink, or without one when `withSink` is false, as the server composes it. The
 * sink reads the memory work queue synchronously as it fires, so the rows it sees are exactly those committed first.
 */
function createResyncRuntime(input: { readonly withSink: boolean; readonly dispatchable: () => boolean; }): ResyncRuntime {
    const resyncs: ALInboundResyncRequired[] = [];
    const workAtResync: (readonly ALPersistedInboundEffect[])[] = [];
    const admissions: ResyncRuntime['admissions'] = [];
    const namespace = `resync-required-${input.withSink ? 'owned' : 'unowned'}`;
    const { backend, stores } = createInboundTestBackendStores({
        namespace,
        storage: 'memory',
        observer: createPassThroughIndexedDbOperationObserver()
    });
    const workQueue = backend.workQueue;
    if (!(workQueue instanceof InMemoryQueueBox)) {
        throw new Error('The resync fixture reads its work rows from the memory queue box');
    }
    const readWorkRows = (): readonly ALPersistedInboundEffect[] =>
        workQueue.peekKeys().flatMap((key) => {
            const entry = workQueue.peek(key);
            return entry === undefined ? [] : [decodeALInboundWorkEntry(entry, namespace)];
        });
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores,
        effectWorkerId: 'al-inbound:resync-required',
        canDispatchMessage: input.dispatchable,
        onResyncRequired: input.withSink
            ? (resync) => {
                resyncs.push(resync);
                workAtResync.push(readWorkRows());
            }
            : undefined
    });
    return {
        fixture,
        resyncs,
        workAtResync,
        admissions,
        admit: async (msg) => {
            admissions.push(await fixture.runtime.admitIncomingMessage(msg, INBOUND_TEST_SOURCE));
        }
    };
}

describe('the resync cursor', () => {
    it('reads where the track stands and what arrived from a resync-required observation', () => {
        const msg = createInboundTestMessage({ msgId: 'message-300', seq: RESYNC_GAP_SEQ });

        expect(toALInboundResyncCursor({ msg, observation: toResyncRequiredObservation(msg, 1), carrier: 'rtc' })).toEqual({
            orderingKey: 'chat',
            senderId: INBOUND_TEST_SENDER_PEER_ID,
            epoch: 0,
            lastContiguousSeq: 1,
            expectedSeq: 2,
            observedSeq: RESYNC_GAP_SEQ,
            carrier: 'rtc'
        });
    });

    it('carries the epoch the track key reads', () => {
        const msg = createInboundTestMessage({ msgId: 'message-300', seq: RESYNC_GAP_SEQ });
        const epochal: ALMessage = { ...msg, ordering: { ...msg.ordering!, epoch: 7 } };

        expect(toALInboundResyncCursor({ msg: epochal, observation: toResyncRequiredObservation(epochal, 1), carrier: 'ws' }))
            .toMatchObject({ epoch: 7, observedSeq: RESYNC_GAP_SEQ });
    });

    it('is undefined for an observation that is not a resynchronization or names no track', () => {
        const msg = createInboundTestMessage({ msgId: 'message-300', seq: RESYNC_GAP_SEQ });
        const untracked = createInboundTestMessage({ msgId: 'message-untracked' });

        expect(toALInboundResyncCursor({
            msg,
            observation: { ...toResyncRequiredObservation(msg, 1), status: 'gap' },
            carrier: 'ws'
        })).toBeUndefined();
        expect(toALInboundResyncCursor({
            msg: untracked,
            observation: { status: 'untracked', missingRanges: [], releasableSeqs: [] },
            carrier: 'ws'
        })).toBeUndefined();
    });
});

describe('the inbound runtime and its recovery sink', () => {
    it('hands a resync-required admission to the sink with the message and its cursor', async () => {
        const owned = createResyncRuntime({ withSink: true, dispatchable: () => true });
        const first = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
        const gapped = createInboundTestMessage({ msgId: 'message-300', seq: RESYNC_GAP_SEQ });

        await owned.admit(first);
        await owned.admit(gapped);

        expect(owned.admissions.at(-1)?.right).toEqual({ kind: 'resync-required' });
        expect(owned.resyncs).toEqual([{
            msg: gapped,
            cursor: {
                orderingKey: 'chat',
                senderId: INBOUND_TEST_SENDER_PEER_ID,
                epoch: 0,
                lastContiguousSeq: 1,
                expectedSeq: 2,
                observedSeq: RESYNC_GAP_SEQ,
                carrier: 'ws'
            }
        }]);
    });

    it('hands an ordered release the track can no longer order to the sink, after its NACK commits', async () => {
        let dispatchable = false;
        const owned = createResyncRuntime({ withSink: true, dispatchable: () => dispatchable });
        const first = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
        const second = createInboundTestMessage({ msgId: 'message-2', seq: 2 });

        await owned.admit(first);
        const workQueue = owned.fixture.stores.workQueue;
        for (const key of await workQueue.getAllKeys()) {
            await workQueue.removeItem(key);
        }
        dispatchable = true;
        await owned.admit(second);

        await expect.poll(async () => {
            await owned.fixture.queueEngine.executeOnce();
            return owned.resyncs;
        }).toEqual([{
            msg: second,
            cursor: {
                orderingKey: 'chat',
                senderId: INBOUND_TEST_SENDER_PEER_ID,
                epoch: 0,
                lastContiguousSeq: 0,
                expectedSeq: 1,
                observedSeq: 2,
                carrier: 'ws'
            }
        }]);
        // The NACK's `send-control` row was already held when the sink heard of the resync.
        const [rowsAtResync] = owned.workAtResync;
        const nackRows = (rowsAtResync ?? []).filter((row) => row.effectId.startsWith(`resync:${INBOUND_TEST_SENDER_PEER_ID}:message-2`));
        expect(nackRows.map((row) => (row.payload.kind === 'send-control' ? row.payload.msg.payload.typeId : row.payload.kind)))
            .toEqual(['al.control.nack.v2']);
        await expect.poll(async () => {
            await owned.fixture.queueEngine.executeOnce();
            return owned.fixture.controlSends.flat().map((control) => control.payload.typeId);
        }).toContain('al.control.nack.v2');
    });

    it('admits and refuses exactly as before where the composition has no sink', async () => {
        const unowned = createResyncRuntime({ withSink: false, dispatchable: () => true });
        const first = createInboundTestMessage({ msgId: 'message-1', seq: 1 });
        const gapped = createInboundTestMessage({ msgId: 'message-300', seq: RESYNC_GAP_SEQ });

        await unowned.admit(first);
        await unowned.admit(gapped);

        expect(unowned.admissions.map((admission) => admission.right)).toEqual([
            { kind: 'admitted' },
            { kind: 'resync-required' }
        ]);
        expect(unowned.resyncs).toEqual([]);
        expect(unowned.fixture.diagnostics.filter((event) => event.kind === 'admission-outcome')).toHaveLength(2);
    });
});
