import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALSeqRangesText } from '@shared/al-contracts/al-seq-range.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    waitForOutboundWorkDrained
} from '../outbound-runtime-test-fixture.ts';

/** One retransmit the carrier ran: the message's sequence and the ranges of the hint that asked for it. */
interface RecordedRepair {
    readonly seq: number;
    readonly hint: string;
}

/** The retransmits one hint produced, in the order the carrier ran them. */
interface RepairPage {
    readonly hint: string;
    readonly seqs: readonly number[];
}

/** The gap a receiver reports: seventy sequences, revealed by the message that followed them. */
const GAP = { from: 2, to: 71 };
const REVEALING_SEQ = 72;

function toOrderedMessage(seq: number): ALMessage {
    return {
        ...createOutboundMessage(`msg-seq-${seq}`),
        ordering: { orderingKey: 'conversation-1', epoch: 0, seq }
    };
}

function toSeqs(from: number, to: number): readonly number[] {
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/** Groups consecutive retransmits by the hint that asked for them, so the pages read in order. */
function toRepairPages(repairs: readonly RecordedRepair[]): readonly RepairPage[] {
    const pages: RepairPage[] = [];
    for (const repair of repairs) {
        const last = pages[pages.length - 1];
        if (last !== undefined && last.hint === repair.hint) {
            pages[pages.length - 1] = { hint: last.hint, seqs: [...last.seqs, repair.seq] };
        }
        else {
            pages.push({ hint: repair.hint, seqs: [repair.seq] });
        }
    }
    return pages;
}

describe('a repair hint is served in pages', () => {
    it('retransmits thirty-two sequences per execution, ascending, and re-commits the rest as one follow-up hint until none remain', async () => {
        const repairs: RecordedRepair[] = [];
        const stores = createDefaultOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: (msg) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: { enabled: true, algo: 'retransmit', maxAttempts: 1 }
            }),
            planRepairMessage: async (msg, request) => ({
                msg,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [{
                    kind: 'repair',
                    seq: String(msg.ordering?.seq),
                    hint: toALSeqRangesText(request.missingRanges)
                }]
            }),
            sendPreparedMessage: async (prepared) => {
                if (prepared.kind === 'repair') {
                    repairs.push({ seq: Number(prepared.seq), hint: prepared.hint! });
                }
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const track = toSeqs(1, REVEALING_SEQ).map(toOrderedMessage);
        for (const message of track) {
            await enqueueOutboundOrThrow(runtime, message);
        }

        await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 3, msgId: 'control-gap', ts: 1, senderId: 'peer-1' },
                {
                    msgId: track[REVEALING_SEQ - 1]!.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'gap',
                    observedAtEpochMs: 1,
                    orderingKey: toALOrderingTrackKey(track[0]!)!,
                    expectedSeq: GAP.from,
                    missingRanges: [GAP]
                }
            ),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);

        expect(AL_MESSAGE_RESOURCE_LIMITS.repairPageMessages).toBe(32);
        expect(repairs.map((repair) => repair.seq)).toEqual(toSeqs(GAP.from, GAP.to));
        expect(toRepairPages(repairs)).toEqual([
            { hint: '2-71', seqs: toSeqs(2, 33) },
            { hint: '34-71', seqs: toSeqs(34, 65) },
            { hint: '66-71', seqs: toSeqs(66, 71) }
        ]);
    });
});
