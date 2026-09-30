import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { IndexedDbOperationKind } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from './inbound-runtime-test-fixture.ts';
import {
    createDefaultOutboundTestRuntime,
    createIndexedDbOutboundCountStores,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from './outbound-test-payload.ts';
import {
    computeIndexedDbLedgerTotals,
    recordIndexedDbTransactionLedger,
    toIndexedDbLedgerTable,
    type IndexedDbLedgerPhase,
    type IndexedDbTransactionLedger,
    type RecordedIndexedDbTransactionLedger
} from './record-indexed-db-transaction-ledger.ts';

const OUTBOUND_NAMESPACE = 'outbound-ledger';
const INBOUND_NAMESPACE = 'al-inbound-ledger';
const INBOUND_WORKER_ID = 'al-inbound:ledger';

// Each run warms its owner first and lets the warm-up's work finish, so the pinned message's window
// holds its own transactions only. Every message carries the ledger table, so a failed pin shows
// which transaction appeared or went away.
describe('outbound warm send IndexedDB transaction ledger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reaches the carrier in 11 transactions and the idle owner in 14', async () => {
        const ledger = await readWarmOutboundSendLedger();
        const chain = computeIndexedDbLedgerTotals(ledger, ['chain']);
        const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            chain.transactions,
            'enqueue to carrier: the decision read, the commit observation read, the fence snapshot and ' +
                'the commit; then the batch\'s exhaustion sweep, claim read, claim write, lease-recovery ' +
                'read, canonical read, supersedence read and receipt read' + table
        ).toBe(11);
        expect(
            total.transactions,
            'the chain, then the release read, the release write and the readiness probe the batch\'s ' +
                'end owes' + table
        ).toBe(14);
        expect(total.requests, 'every get, getAll and put those 14 transactions issue' + table)
            .toBe(46);
        expect(
            total.byOwner['al-admission'],
            '7 decision reads, the supersedence read, the receipt read and the commit' + table
        ).toBe(10);
        expect(
            total.byOwner['al-work'],
            '7 work reads (2 decision, 3 commit observation, 2 canonical), 2 empty probes, the ' +
                'reservation, the release and the readiness page' + table
        ).toBe(12);
    });
});

describe('inbound warm admit-and-deliver IndexedDB transaction ledger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('admits and delivers the fourth message, whose commit takes a plain head read, in 11 transactions', async () => {
        const ledger = await readWarmInboundDeliveryLedger(3);
        const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            total.transactions,
            'the decision read, the fence snapshot and the commit; the commit\'s batch: exhaustion sweep, ' +
                'head page read, readiness read, claim read, claim write and lease-recovery read; then ' +
                'the release read and write' + table
        ).toBe(11);
        expect(total.requests, 'every get, getAll and put those 11 transactions issue' + table)
            .toBe(34);
        expect(
            total.byOwner['al-admission'],
            '5 decision reads, the commit and the 2 readiness reads the dispatch reuses' + table
        ).toBe(8);
        expect(
            total.byOwner['al-work'],
            '2 empty probes, the page read, the reservation and the release' + table
        ).toBe(5);
    });

    it('admits and delivers the second message, whose head read waits one rotation batch, in 13 transactions', async () => {
        const ledger = await readWarmInboundDeliveryLedger(1);
        const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            total.transactions,
            'a head read ran since the last rotation read, so the commit\'s head read waits one ' +
                'batch: the 11, plus that rotation batch\'s exhaustion sweep and page read' + table
        ).toBe(13);
        expect(total.requests, 'the 34, plus the rotation batch\'s 2 getAll' + table).toBe(36);
        expect(
            total.byOwner['al-admission'],
            'the rotation batch reads no admission row: 8, as after a rotation read' + table
        ).toBe(8);
        expect(
            total.byOwner['al-work'],
            'the 5, plus the rotation batch\'s empty probe and page read' + table
        ).toBe(7);
    });
});

async function readWarmOutboundSendLedger(): Promise<IndexedDbTransactionLedger> {
    const recorded = recordIndexedDbTransactionLedger();
    let phaseAtSend: IndexedDbLedgerPhase = 'before';
    const runtime = createDefaultOutboundTestRuntime({
        stores: createIndexedDbOutboundCountStores(recorded.observer, OUTBOUND_NAMESPACE),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [{ kind: 'send' }]
        }),
        sendPreparedMessage: async () => {
            recorded.setPhase(phaseAtSend);
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    await sendUntilOwnerIdle(runtime, recorded, 'msg-ledger-warm-up');
    recorded.setPhase('chain');
    phaseAtSend = 'after-send';
    await sendUntilOwnerIdle(runtime, recorded, 'msg-ledger-pinned');
    return recorded.getLedger();
}

/**
 * The commit's own batch sends the message; the owner is idle once the readiness probe the batch's
 * end schedules has read storage after the release. Waiting for that probe keeps it out of the next
 * send's chain.
 */
async function sendUntilOwnerIdle(
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>,
    recorded: RecordedIndexedDbTransactionLedger,
    resourceId: string
): Promise<void> {
    const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage(resourceId));
    expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: true });
    await vi.waitFor(() => {
        expect(isProbedAfterRelease(recorded.getLedger())).toBe(true);
        expect(recorded.liveCount()).toBe(0);
    });
}

function isProbedAfterRelease(ledger: IndexedDbTransactionLedger): boolean {
    const kinds = ledger.operations.map((operation) => operation.kind);
    const release = kinds.lastIndexOf('work-release');
    return release >= 0 && kinds.lastIndexOf('work-page') > release;
}

/**
 * Only the commits' own batches move the rotation here, so its phase is a function of the message
 * count. From `ready()`, the first message's commit takes a head read. The second finds a head read
 * already taken since the last rotation read and waits one rotation batch for its own. The third's
 * rotation batch wraps the scan to the head of NEW, so its own read there is a rotation read, and the
 * fourth takes a head read again without waiting.
 */
async function readWarmInboundDeliveryLedger(
    warmUpMessages: number
): Promise<IndexedDbTransactionLedger> {
    const recorded = recordIndexedDbTransactionLedger();
    let phaseAtDispatch: IndexedDbLedgerPhase = 'before';
    const fixture = createInboundTestRuntime({
        carrier: 'ws',
        stores: createInboundTestStores({
            namespace: INBOUND_NAMESPACE,
            storage: 'indexeddb',
            observer: recorded.observer
        }),
        effectWorkerId: INBOUND_WORKER_ID,
        gateDispatch: async () => {
            recorded.setPhase(phaseAtDispatch);
        }
    });
    await fixture.runtime.ready();
    for (let message = 1; message <= warmUpMessages; message += 1) {
        await admitUntilReleased(fixture, recorded, `ledger-warm-up-${message}`);
    }
    recorded.setPhase('chain');
    phaseAtDispatch = 'after-send';
    await admitUntilReleased(fixture, recorded, 'ledger-pinned');
    return recorded.getLedger();
}

/** The fixture's engine never runs on its own: the commit's batches deliver, and the release ends them. */
async function admitUntilReleased(
    fixture: InboundTestRuntime,
    recorded: RecordedIndexedDbTransactionLedger,
    msgId: string
): Promise<void> {
    const delivered = fixture.delivered.length + 1;
    const admitted = await fixture.runtime.admitIncomingMessage(
        createInboundTestMessage({ msgId }),
        INBOUND_TEST_SOURCE
    );
    expect(admitted.right).toEqual({ kind: 'admitted' });
    await vi.waitFor(() => {
        expect(fixture.delivered).toHaveLength(delivered);
        expect(countOperations(recorded.getLedger(), 'work-release')).toBe(delivered);
        expect(recorded.liveCount()).toBe(0);
    });
}

function countOperations(ledger: IndexedDbTransactionLedger, kind: IndexedDbOperationKind): number {
    return ledger.operations.filter((operation) => operation.kind === kind).length;
}
