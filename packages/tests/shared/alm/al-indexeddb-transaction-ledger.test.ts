import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
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
    createIndexedDbOutboundTestStores,
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

const SINGLE_SEND_OBSERVATION_REASON = 'no observation read: a single send\'s decision read also reads the effect ' +
    'row its commit writes and holds the canonical pair, so the commit re-reads neither';
const CANONICAL_HANDOFF_REASON = 'no canonical read: the claim takes the canonical pair its own commit handed ' +
    'over instead of reading it back';
const SEND_GUARDS_SESSION_REASON = 'one guard read: a prepared send reads its supersedence and receipt guards in ' +
    'one session';
const READINESS_RESTORE_REASON = 'no readiness probe after the batch: the batch claimed and completed the one row ' +
    'its commit wrote, so it restores the answer that commit set aside';
const LANE_CLOCK_REASON = 'no lease sweep: the bootstrap batch spent both sweeps\' allowances, and the lane clock ' +
    'stands still for the run, so their windows stay closed';
const WORK_ROW_PARSES = 'each read that decodes the work row parses its 4 timestamps (date, created, expiry and ' +
    'its one dequeue instant) once; a row the owner wrote is never parsed back';

// Each run warms its owner first and lets the warm-up's work finish, so the pinned message's window
// holds its own transactions only. Every message carries the ledger table, so a failed pin shows
// which transaction appeared or went away.
describe('outbound warm send IndexedDB transaction ledger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reaches the carrier in 6 transactions and the idle owner in 8', async () => {
        const ledger = await readWarmOutboundSendLedger();
        const chain = computeIndexedDbLedgerTotals(ledger, ['chain']);
        const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            chain.transactions,
            'enqueue to carrier: the decision read, the fence snapshot and the commit; then the batch\'s ' +
                'claim read, claim write and guard read; ' + LANE_CLOCK_REASON + '; ' +
                SINGLE_SEND_OBSERVATION_REASON + '; ' + CANONICAL_HANDOFF_REASON + '; ' +
                SEND_GUARDS_SESSION_REASON + table
        ).toBe(6);
        expect(
            total.transactions,
            'the chain\'s 6, then the release read and the release write; ' + READINESS_RESTORE_REASON + table
        ).toBe(8);
        expect(
            total.requests,
            'every get, getAll and put those 8 transactions issue; the guard read issues its 2 gets ' +
                'in one session' + table
        ).toBe(37);
        expect(total.droppedRequests, 'every request ran on a transaction the ledger recorded' + table)
            .toBe(0);
        expect(
            total.byOwner['al-admission'],
            '7 decision reads, the supersedence and receipt reads (one session, one op per key) and the ' +
                'commit' + table
        ).toBe(10);
        expect(
            total.byOwner['al-work'],
            '3 decision work reads, the reservation and the release; ' + LANE_CLOCK_REASON + '; ' +
                CANONICAL_HANDOFF_REASON + '; ' + READINESS_RESTORE_REASON + table
        ).toBe(5);
    });

    it('parses 4 timestamps up to the carrier and 8 up to the idle owner', async () => {
        const ledger = await readWarmOutboundSendLedger();
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            computeIndexedDbLedgerTotals(ledger, ['chain']).temporalParses,
            'the claim read decodes the work row (4); ' + LANE_CLOCK_REASON + '; ' + WORK_ROW_PARSES + table
        ).toEqual({ instant: 2, plainTime: 1, plainDateTime: 1 });
        expect(
            computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']).temporalParses,
            'the chain\'s 4, then the release read decodes the work row (4); the release write parses ' +
                'nothing' + table
        ).toEqual({ instant: 4, plainTime: 2, plainDateTime: 2 });
    });
});

describe('inbound warm admit-and-deliver IndexedDB transaction ledger', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('admits and delivers the fourth message, whose commit takes a plain head read, in 11 transactions', async () => {
        const ledger = await readWarmInboundDeliveryLedger(3);
        const chain = computeIndexedDbLedgerTotals(ledger, ['chain']);
        const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            chain.transactions,
            'admission to dispatch: the decision read, the fence snapshot and the commit; the ' +
                'commit\'s batch: exhaustion sweep, head page read, readiness read, claim read, claim ' +
                'write and lease-recovery read' + table
        ).toBe(9);
        expect(
            total.transactions,
            'the chain\'s 9, then the release read and write' + table
        ).toBe(11);
        expect(total.requests, 'every get, getAll and put those 11 transactions issue' + table)
            .toBe(34);
        expect(total.droppedRequests, 'every request ran on a transaction the ledger recorded' + table)
            .toBe(0);
        expect(
            total.byOwner['al-admission'],
            '5 decision reads, the commit and the 2 readiness reads the dispatch reuses' + table
        ).toBe(8);
        expect(
            total.byOwner['al-work'],
            '2 empty probes, the page read, the reservation and the release' + table
        ).toBe(5);
        expect(
            total.temporalParses,
            'the head page read, the claim read and the lease-recovery read decode the work row before ' +
                'dispatch (12), and the release read after it (4); ' + WORK_ROW_PARSES + table
        ).toEqual({ instant: 8, plainTime: 4, plainDateTime: 4 });
    });

    it('admits and delivers the second message, whose head read waits one rotation batch, in 13 transactions', async () => {
        const ledger = await readWarmInboundDeliveryLedger(1);
        const chain = computeIndexedDbLedgerTotals(ledger, ['chain']);
        const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
        const table = `\n${toIndexedDbLedgerTable(ledger)}`;

        expect(
            chain.transactions,
            'a head read ran since the last rotation read, so the commit\'s head read waits one ' +
                'batch: the decision read, the fence snapshot and the commit; that rotation batch\'s ' +
                'exhaustion sweep and page read; then the head batch\'s exhaustion sweep, head page ' +
                'read, readiness read, claim read, claim write and lease-recovery read' + table
        ).toBe(11);
        expect(
            total.transactions,
            'the chain\'s 11, then the release read and write' + table
        ).toBe(13);
        expect(
            total.requests,
            'every get, getAll and put those 13 transactions issue: the rotation batch adds its 2 getAll' +
                table
        ).toBe(36);
        expect(total.droppedRequests, 'every request ran on a transaction the ledger recorded' + table)
            .toBe(0);
        expect(
            total.byOwner['al-admission'],
            'the rotation batch reads no admission row: 5 decision reads, the commit and the 2 ' +
                'readiness reads' + table
        ).toBe(8);
        expect(
            total.byOwner['al-work'],
            '2 empty probes, the page read, the reservation and the release, plus the rotation ' +
                'batch\'s empty probe and page read' + table
        ).toBe(7);
        expect(
            total.temporalParses,
            'the rotation batch\'s page read decodes no row, so the same 16 as the fourth message: ' +
                WORK_ROW_PARSES + table
        ).toEqual({ instant: 8, plainTime: 4, plainDateTime: 4 });
    });
});

async function readWarmOutboundSendLedger(): Promise<IndexedDbTransactionLedger> {
    const recorded = recordIndexedDbTransactionLedger();
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    let phaseAtSend: IndexedDbLedgerPhase = 'before';
    // The lane clock stands still: the sweep windows the bootstrap batch spent stay closed however long the run takes.
    const laneNowMs = Date.now();
    const runtime = createDefaultOutboundTestRuntime({
        stores: createIndexedDbOutboundTestStores({ observer: recorded.observer, namespace: OUTBOUND_NAMESPACE }),
        nowMs: () => laneNowMs,
        diagnostics: (event) => diagnostics.push(event),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'durable',
            preparedMessages: [{ kind: 'send' }]
        }),
        sendPreparedMessage: async () => {
            recorded.setPhase(phaseAtSend);
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    // The owner's first probe takes the answer each send's commit sets aside and its batch restores.
    await runtime.ready();
    await vi.waitFor(() => {
        expect(diagnostics.some((event) => event.kind === 'readiness-probe')).toBe(true);
        expect(recorded.liveCount()).toBe(0);
    });
    await sendUntilOwnerIdle({ runtime, recorded, diagnostics, resourceId: 'msg-ledger-warm-up' });
    recorded.setPhase('chain');
    phaseAtSend = 'after-send';
    await sendUntilOwnerIdle({ runtime, recorded, diagnostics, resourceId: 'msg-ledger-pinned' });
    return recorded.getLedger();
}

interface OutboundSendUntilIdleInput {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly recorded: RecordedIndexedDbTransactionLedger;
    readonly diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[];
    readonly resourceId: string;
}

/**
 * The commit's own batch sends the message; the owner is idle once that batch has released the row,
 * reported its drain and left no transaction open. A clean batch restores the readiness answer its
 * commit set aside, so no probe follows it.
 */
async function sendUntilOwnerIdle(input: OutboundSendUntilIdleInput): Promise<void> {
    const { recorded, diagnostics } = input;
    const releasesBefore = computeOperationCount(recorded.getLedger(), 'work-release');
    const drainsBefore = computeEffectDrainCount(diagnostics);
    const enqueued = await input.runtime.enqueueIfAbsent(createOutboundMessage(input.resourceId));
    expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: true });
    // The warm-up's release and drain are already recorded, so only counts taken before this send
    // can tell its own from theirs.
    await vi.waitFor(() => {
        expect(computeOperationCount(recorded.getLedger(), 'work-release')).toBe(releasesBefore + 1);
        expect(computeEffectDrainCount(diagnostics)).toBe(drainsBefore + 1);
        expect(recorded.liveCount()).toBe(0);
    });
}

function computeEffectDrainCount(diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]): number {
    return diagnostics.filter((event) => event.kind === 'effect-drain' && event.lane === 'durable').length;
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
        expect(computeOperationCount(recorded.getLedger(), 'work-release')).toBe(delivered);
        expect(recorded.liveCount()).toBe(0);
    });
}

function computeOperationCount(ledger: IndexedDbTransactionLedger, kind: IndexedDbOperationKind): number {
    return ledger.operations.filter((operation) => operation.kind === kind).length;
}
