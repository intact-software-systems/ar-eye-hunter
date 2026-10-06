import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALNackControlMessage,
    newALRepairControlMessage,
    type ALNackPayload,
    type ALRepairPayload
} from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundPlanner,
    ALOutboundRepairHint
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundSettlementFact
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundRepairRetransmission } from '@shared/alm/outbound/al-outbound-repair-retransmission.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    createOutboundWorkPort,
    enqueueOutboundOrThrow,
    runOutboundWorkTask,
    waitForOutboundWorkDrained,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

/** The two fields a skipped settlement is judged by here; the rest is the runtime's stamp. */
interface SkippedRepair {
    readonly msgId: string;
    readonly reason: string;
}

/** Every message of the track retransmits once at most (`maxRepairs: 1`). */
const planOutgoingMessage: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    lane: 'durable',
    preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
    repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 1 }
});

async function planRepairMessage(msg: ALMessage): Promise<ALOutboundDispatchPlan<OutboundTestPayload>> {
    return {
        msg,
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: [{ kind: 'repair', msgId: msg.id.msgId }]
    };
}

function toOrderedMessage(seq: number): ALMessage {
    return {
        ...createOutboundMessage(`msg-seq-${seq}`),
        ordering: { orderingKey: 'conversation-1', epoch: 0, seq }
    };
}

/** What every control of the test shares: the addressee reports a gap before the revealing message. */
function toGapReport(revealing: ALMessage, trackKey: string, missingRanges: readonly ALSeqRange[]) {
    return {
        msgId: revealing.id.msgId,
        fromPeerId: 'peer-1',
        toPeerId: 'self',
        observedAtEpochMs: 1,
        orderingKey: trackKey,
        expectedSeq: 1,
        missingRanges
    };
}

function toGapNack(controlMsgId: string, report: Omit<ALNackPayload, 'reason'>): ALMessage {
    return newALNackControlMessage(
        { v: 2, msgId: controlMsgId, ts: 1, senderId: 'peer-1' },
        { ...report, reason: 'gap' }
    );
}

function toMissingSeqRepair(controlMsgId: string, report: Omit<ALRepairPayload, 'reason'>): ALMessage {
    return newALRepairControlMessage(
        { v: 2, msgId: controlMsgId, ts: 1, senderId: 'peer-1' },
        { ...report, reason: 'missing-seq' }
    );
}

function toSkippedRepairs(settlements: readonly (ALDeliverySettlement | ALOutboundSettlementFact)[]): readonly SkippedRepair[] {
    return settlements.flatMap((settlement) =>
        settlement.kind === 'admission' && settlement.verdict.kind === 'skipped'
            ? [{ msgId: settlement.msgId, reason: settlement.verdict.reason }]
            : []
    );
}

/** The repair-by-hint owner over the runtime's stores, as the lane builds it, executing hints on demand. */
function createRepairRetransmission(
    stores: OutboundTestStores,
    settlements: ALOutboundSettlementFact[]
): ALOutboundRepairRetransmission<OutboundTestPayload> {
    const record = (fact: ALOutboundSettlementFact): void => {
        settlements.push(fact);
    };
    return new ALOutboundRepairRetransmission({
        admissionStore: stores.admissionStore,
        dispatchAdmission: new ALOutboundDispatchAdmission({
            lane: 'durable',
            admissionStore: stores.admissionStore,
            workPort: createOutboundWorkPort(stores.workQueue, stores.admissionStore.namespace),
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            diagnostics: undefined,
            settlements: record
        }),
        planOutgoingMessage,
        planRepairMessage,
        hopPeerIds: undefined,
        settlements: record
    });
}

async function readRepairAttempts(stores: OutboundTestStores, messages: readonly ALMessage[]): Promise<readonly number[]> {
    return await Promise.all(
        messages.map(async (message) => (await stores.admissionStore.readRepairMessage(message.id.msgId, planOutgoingMessage)).repairAttempt?.attempts ?? 0)
    );
}

describe('the repair budget runs out', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('serves a NACK and a repair request for one gap as one hint, settles a later report of the spent budget skipped once, and warns nothing', async () => {
        const warnings: string[] = [];
        vi.spyOn(console, 'warn').mockImplementation((message: string) => {
            warnings.push(message);
        });
        const settlements: ALDeliverySettlement[] = [];
        const repairs: string[] = [];
        const stores = createDefaultOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            settlements: (settlement) => settlements.push(settlement),
            planOutgoingMessage,
            planRepairMessage,
            sendPreparedMessage: async (prepared) => {
                if (prepared.kind === 'repair') {
                    repairs.push(prepared.msgId!);
                }
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const [first, second, third, fourth] = [1, 2, 3, 4].map(toOrderedMessage) as [
            ALMessage,
            ALMessage,
            ALMessage,
            ALMessage
        ];
        for (const message of [first, second, third, fourth]) {
            await enqueueOutboundOrThrow(runtime, message);
        }
        const trackKey = toALOrderingTrackKey(first)!;

        // Seq 3 reveals the gap: its receiver raises a NACK and a repair request naming the same two
        // sequences. They are one hint, so each predecessor is retransmitted once, which spends its budget of one.
        await runtime.acceptControlMessage(
            toGapNack('control-gap-3', toGapReport(third, trackKey, [{ from: 1, to: 2 }])),
            'peer'
        );
        await runtime.acceptControlMessage(
            toMissingSeqRepair('control-repair-3', toGapReport(third, trackKey, [{ from: 1, to: 2 }])),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([]);

        // Seq 4 reveals the gap once more: a new hint finds both budgets spent and settles each message once.
        await runtime.acceptControlMessage(
            toGapNack('control-gap-4', toGapReport(fourth, trackKey, [{ from: 1, to: 2 }])),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([
            { msgId: first.id.msgId, reason: 'repair-exhausted' },
            { msgId: second.id.msgId, reason: 'repair-exhausted' }
        ]);

        // The repair request of seq 4 joins its NACK's hint; a narrower report states nothing more.
        await runtime.acceptControlMessage(
            toMissingSeqRepair('control-repair-4', toGapReport(fourth, trackKey, [{ from: 1, to: 2 }])),
            'peer'
        );
        await runtime.acceptControlMessage(
            toGapNack('control-gap-4-first', toGapReport(fourth, trackKey, [{ from: 1, to: 1 }])),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);

        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([
            { msgId: first.id.msgId, reason: 'repair-exhausted' },
            { msgId: second.id.msgId, reason: 'repair-exhausted' }
        ]);
        expect(settlements.find((settlement) => settlement.msgId === first.id.msgId && settlement.kind === 'admission'))
            .toEqual({
                kind: 'admission',
                msgId: first.id.msgId,
                carrier: 'ws',
                atMs: expect.any(Number),
                lane: 'durable',
                trackedReceiptAlgo: 'none',
                verdict: {
                    kind: 'skipped',
                    reason: 'repair-exhausted',
                    detail: `The repair of ${first.id.msgId} ran out of retransmits after 1 of 1.`
                }
            });
        expect(warnings.filter((message) => message.includes('budget'))).toEqual([]);
    });

    it('charges one attempt per hint identity: a re-executed hint neither charges again nor exhausts, a new hint does', async () => {
        const repairs: string[] = [];
        const stores = createDefaultOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage,
            planRepairMessage,
            sendPreparedMessage: async (prepared) => {
                if (prepared.kind === 'repair') {
                    repairs.push(prepared.msgId!);
                }
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const [first, second, third, fourth] = [1, 2, 3, 4].map(toOrderedMessage) as [
            ALMessage,
            ALMessage,
            ALMessage,
            ALMessage
        ];
        for (const message of [first, second, third, fourth]) {
            await enqueueOutboundOrThrow(runtime, message);
        }
        await waitForOutboundWorkDrained(stores);
        const settlements: ALOutboundSettlementFact[] = [];
        const retransmission = createRepairRetransmission(stores, settlements);
        const gap: ALOutboundRepairHint = {
            trigger: 'nack',
            requestedByPeerId: 'peer-1',
            orderingTrackKey: toALOrderingTrackKey(first)!,
            missingRanges: [{ from: 1, to: 2 }],
            failedPeerIds: []
        };

        // The hint of seq 3 runs twice under one identity, as a conflict or an expired lease re-runs it:
        // its sends are deduplicated by their identity, and so is the attempt they charge.
        await retransmission.retransmitFromRepairHint(third.id.msgId, gap, 'repair-hint-3');
        await retransmission.retransmitFromRepairHint(third.id.msgId, gap, 'repair-hint-3');
        await runOutboundWorkTask(runtime);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(await readRepairAttempts(stores, [first, second])).toEqual([1, 1]);
        expect(toSkippedRepairs(settlements)).toEqual([]);

        // The hint of seq 4 is a new identity: it finds the budget spent and states so once per message.
        await retransmission.retransmitFromRepairHint(fourth.id.msgId, gap, 'repair-hint-4');
        await retransmission.retransmitFromRepairHint(fourth.id.msgId, gap, 'repair-hint-4');
        await runOutboundWorkTask(runtime);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(await readRepairAttempts(stores, [first, second])).toEqual([1, 1]);
        expect(toSkippedRepairs(settlements)).toEqual([
            { msgId: first.id.msgId, reason: 'repair-exhausted' },
            { msgId: second.id.msgId, reason: 'repair-exhausted' }
        ]);
    });
});

describe('a ranged hint whose sequences have left the sent cache', () => {
    it('retransmits nothing and charges nothing, the message that revealed the gap included', async () => {
        const repairs: string[] = [];
        const stores = createDefaultOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage,
            planRepairMessage,
            sendPreparedMessage: async (prepared) => {
                if (prepared.kind === 'repair') {
                    repairs.push(prepared.msgId!);
                }
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const track = [40, 41, 42].map(toOrderedMessage);
        for (const message of track) {
            await enqueueOutboundOrThrow(runtime, message);
        }
        await waitForOutboundWorkDrained(stores);
        const settlements: ALOutboundSettlementFact[] = [];
        const retransmission = createRepairRetransmission(stores, settlements);
        const revealing = track[2]!;
        const gapBeforeTheCache: ALOutboundRepairHint = {
            trigger: 'nack',
            requestedByPeerId: 'peer-1',
            orderingTrackKey: toALOrderingTrackKey(revealing)!,
            missingRanges: [{ from: 1, to: 2 }],
            failedPeerIds: []
        };

        await retransmission.retransmitFromRepairHint(revealing.id.msgId, gapBeforeTheCache, 'repair-hint-42');
        await runOutboundWorkTask(runtime);

        expect(repairs).toEqual([]);
        expect(await readRepairAttempts(stores, track)).toEqual([0, 0, 0]);
        expect(toSkippedRepairs(settlements)).toEqual([]);
    });
});
