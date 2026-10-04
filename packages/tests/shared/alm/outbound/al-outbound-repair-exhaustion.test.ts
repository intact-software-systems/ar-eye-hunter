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

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    waitForOutboundWorkDrained
} from '../outbound-runtime-test-fixture.ts';

/** The two fields a skipped settlement is judged by here; the rest is the runtime's stamp. */
interface SkippedRepair {
    readonly msgId: string;
    readonly reason: string;
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

function toSkippedRepairs(settlements: readonly ALDeliverySettlement[]): readonly SkippedRepair[] {
    return settlements.flatMap((settlement) =>
        settlement.kind === 'admission' && settlement.verdict.kind === 'skipped'
            ? [{ msgId: settlement.msgId, reason: settlement.verdict.reason }]
            : []
    );
}

describe('the repair budget runs out', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('settles each exhausted message skipped as repair-exhausted once across two exhausted hints, and warns nothing', async () => {
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
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 1 }
            }),
            planRepairMessage: async (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [{ kind: 'repair', msgId: msg.id.msgId }]
            }),
            sendPreparedMessage: async (prepared) => {
                if (prepared.kind === 'repair') {
                    repairs.push(prepared.msgId!);
                }
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const [first, second, revealing] = [1, 2, 3].map(toOrderedMessage) as [ALMessage, ALMessage, ALMessage];
        for (const message of [first, second, revealing]) {
            await enqueueOutboundOrThrow(runtime, message);
        }
        const trackKey = toALOrderingTrackKey(first)!;

        // The gap names both predecessors: each is retransmitted once, which spends its budget of one.
        await runtime.acceptControlMessage(
            toGapNack('control-gap', toGapReport(revealing, trackKey, [{ from: 1, to: 2 }])),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);

        // A repair request for the same gap finds both budgets spent; a narrower NACK then exhausts the
        // first message a second time.
        await runtime.acceptControlMessage(
            toMissingSeqRepair('control-repair', toGapReport(revealing, trackKey, [{ from: 1, to: 2 }])),
            'peer'
        );
        await runtime.acceptControlMessage(
            toGapNack('control-gap-first', toGapReport(revealing, trackKey, [{ from: 1, to: 1 }])),
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
});
