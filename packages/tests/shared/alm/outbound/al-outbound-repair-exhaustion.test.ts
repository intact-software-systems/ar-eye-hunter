import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    decodeALPeerControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage,
    type ALNackPayload,
    type ALRepairPayload
} from '@shared/al-contracts/al-control.ts';
import { AL_GAP_NACK_RELAY_HOP_LIMIT } from '@shared/al-contracts/al-message-resource-limits.ts';
import { toALOrderingTrackKey, type ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
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
import { RtcReceiptProofVerifier } from '@shared/multicast/receipt-proof/rtc-receipt-proof-verifier.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    runOutboundWorkTask,
    waitForOutboundWorkDrained,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

import { signTestALReceiptControl } from '../../../al-control-test-payloads.ts';
import {
    createAvailablePublicationCryptoFixture,
    ROOM_PUBLICATION_CRYPTO,
    ROOM_PUBLICATION_KEY,
    type AvailablePublicationCrypto
} from '../../signature/publication-crypto-fixtures.ts';

/** The two fields a skipped settlement is judged by here; the rest is the runtime's stamp. */
interface SkippedRepair {
    readonly msgId: string;
    readonly reason: string;
}

/** Every message of the track retransmits once at most to each requester (`maxRepairs: 1`). */
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

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' } as const;

/** A frame of the same track sent with no receipt to the room's frozen audience `peer-3`, neither addressee nor hop. */
function createFrozenOrderedMessage(seq: number): ALMessage {
    return {
        ...createOrderedMessage(seq),
        targets: { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['peer-3'], snapshotVersion: 1 }
    };
}

function createOrderedMessage(seq: number): ALMessage {
    return {
        ...createOutboundMessage(`msg-seq-${seq}`),
        ordering: { orderingKey: 'conversation-1', epoch: 0, seq }
    };
}

interface GapReportInput {
    readonly revealing: ALMessage;
    readonly trackKey: string;
    readonly missingRanges: readonly ALSeqRange[];
    readonly requester?: string;
}

/** What every control of the test shares: the addressee reports a gap before the revealing message. */
function toGapReport(
    { revealing, trackKey, missingRanges, requester = 'peer-1' }: GapReportInput
): Omit<ALNackPayload, 'reason' | 'logicalRecipientPeerId' | 'originPeerId' | 'proof'> {
    return {
        msgId: revealing.id.msgId,
        fromPeerId: requester,
        toPeerId: 'self',
        observedAtEpochMs: 1,
        orderingKey: trackKey,
        expectedSeq: 1,
        missingRanges
    };
}

function toGapNack(controlMsgId: string, report: Omit<ALNackPayload, 'reason' | 'logicalRecipientPeerId' | 'originPeerId' | 'proof'>): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: controlMsgId, ts: 1, senderId: report.fromPeerId, traceId: 'trace-al-outbound-repair-exhaustion' },
        {
            gapRequestNumber: 1,
            relayHopsLeft: AL_GAP_NACK_RELAY_HOP_LIMIT,
            ...report,
            logicalRecipientPeerId: report.fromPeerId,
            originPeerId: report.toPeerId,
            reason: 'gap',
            proof: null
        }
    );
}

/** A gap NACK the relay `report.fromPeerId` forwards for `recipientPeerId`, unsigned. */
function toRelayedGapNack(
    controlMsgId: string,
    report: Omit<ALNackPayload, 'reason' | 'logicalRecipientPeerId' | 'originPeerId' | 'proof'>,
    recipientPeerId: string
): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: controlMsgId, ts: 1, senderId: report.fromPeerId, traceId: 'trace-al-outbound-repair-exhaustion' },
        {
            gapRequestNumber: 1,
            relayHopsLeft: AL_GAP_NACK_RELAY_HOP_LIMIT,
            ...report,
            logicalRecipientPeerId: recipientPeerId,
            originPeerId: report.toPeerId,
            reason: 'gap',
            proof: null
        }
    );
}

/** The relayed gap NACK `nack` carrying the signature `crypto` makes over it. */
async function toSignedRelayedGapNack(nack: ALMessage, crypto: AvailablePublicationCrypto): Promise<ALMessage> {
    const control = decodeALPeerControlMessage(nack).right;
    if (control?.type !== 'nack') {
        throw new Error('A relayed gap NACK decodes as a NACK');
    }
    return newALNackControlMessage(nack.id, (await signTestALReceiptControl(crypto, control)).payload);
}

function toMissingSeqRepair(controlMsgId: string, report: Omit<ALRepairPayload, 'reason'>): ALMessage {
    return newALRepairControlMessage(
        { v: 4, msgId: controlMsgId, ts: 1, senderId: report.fromPeerId, traceId: 'trace-al-outbound-repair-exhaustion' },
        { ...report, reason: 'missing-seq', gapRequestNumber: 1 }
    );
}

function toSkippedRepairs(settlements: readonly (ALDeliverySettlement | ALOutboundSettlementFact)[]): readonly SkippedRepair[] {
    return settlements.flatMap((settlement) =>
        settlement.kind === 'admission' && settlement.verdict.kind === 'skipped'
            ? [{ msgId: settlement.msgId, reason: settlement.verdict.reason }]
            : []
    );
}

type RepairPlanners = Pick<ALOutboundRepairRetransmission.Dependencies<OutboundTestPayload>, 'planOutgoingMessage' | 'planRepairMessage'>;

/** The repair-by-hint owner over the runtime's stores, as the lane builds it, executing hints on demand. */
function createRepairRetransmission(
    stores: OutboundTestStores,
    settlements: ALOutboundSettlementFact[],
    planners: RepairPlanners
): ALOutboundRepairRetransmission<OutboundTestPayload> {
    const record = (fact: ALOutboundSettlementFact): void => {
        settlements.push(fact);
    };
    return new ALOutboundRepairRetransmission({
        admissionStore: stores.admissionStore,
        dispatchAdmission: new ALOutboundDispatchAdmission({
            lane: 'durable',
            admissionStore: stores.admissionStore,
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox', Temporal.Now.instant()),
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            signAdmittedMessage: undefined,
            diagnostics: undefined,
            settlements: record
        }),
        planOutgoingMessage: planners.planOutgoingMessage,
        planRepairMessage: planners.planRepairMessage,
        hopPeerIds: undefined,
        settlements: record
    });
}

async function readRepairAttempts(
    stores: OutboundTestStores,
    messages: readonly ALMessage[],
    requester = 'peer-1'
): Promise<readonly number[]> {
    return await Promise.all(
        messages.map(async (message) =>
            (await stores.admissionStore.readOutgoingMessage({
                msg: message,
                planner: planOutgoingMessage,
                observedCanonicalEntry: undefined,
                intent: 'enqueue'
            }))
                .repairAttempt?.attemptsByRequester[requester] ?? 0
        )
    );
}

describe('the repair budget runs out', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('serves a NACK and a repair request for one gap as one hint, charges a later frame\'s report of it nothing, gives another requester its own budget, and settles a renewal past a requester\'s budget skipped once', async () => {
        const warnings: string[] = [];
        vi.spyOn(console, 'warn').mockImplementation((message: string) => {
            warnings.push(message);
        });
        const settlements: ALDeliverySettlement[] = [];
        const repairs: string[] = [];
        const stores = createDefaultOutboundTestStores();
        // peer-2 is the hop every frame passes through, so its controls are a repair peer's as the addressee's are.
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            settlements: (settlement) => settlements.push(settlement),
            hopPeerIds: ['peer-2'],
            planOutgoingMessage,
            planRepairMessage,
            sendPreparedMessage: async (prepared) => {
                if (prepared.kind === 'repair') {
                    repairs.push(prepared.msgId!);
                }
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const [first, second, third, fourth] = [1, 2, 3, 4].map(createOrderedMessage) as [
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
            toGapNack('control-gap-3', toGapReport({ revealing: third, trackKey, missingRanges: [{ from: 1, to: 2 }] })),
            'peer'
        );
        await runtime.acceptControlMessage(
            toMissingSeqRepair('control-repair-3', toGapReport({ revealing: third, trackKey, missingRanges: [{ from: 1, to: 2 }] })),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([]);

        // Seq 4 reveals the same gap to the same requester: each sequence finds its first attempt and charges nothing.
        await runtime.acceptControlMessage(
            toGapNack('control-gap-4', toGapReport({ revealing: fourth, trackKey, missingRanges: [{ from: 1, to: 2 }] })),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([]);

        // The budget counts per requester (the maintainer's ruling): another requester's report of the same
        // sequences is its own attempt under its own budget, served once.
        await runtime.acceptControlMessage(
            toGapNack('control-gap-4-peer-2', toGapReport({ revealing: fourth, trackKey, missingRanges: [{ from: 1, to: 2 }], requester: 'peer-2' })),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId, first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([]);

        // That requester's repair request joins its NACK's hint; a narrower report states nothing more.
        await runtime.acceptControlMessage(
            toMissingSeqRepair(
                'control-repair-4-peer-2',
                toGapReport({ revealing: fourth, trackKey, missingRanges: [{ from: 1, to: 2 }], requester: 'peer-2' })
            ),
            'peer'
        );
        await runtime.acceptControlMessage(
            toGapNack('control-gap-4-first-peer-2', toGapReport({ revealing: fourth, trackKey, missingRanges: [{ from: 1, to: 1 }], requester: 'peer-2' })),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId, first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([]);

        // peer-1's renewal is a new attempt past its own budget of one: each message is settled skipped once.
        await runtime.acceptControlMessage(
            toGapNack('control-renewal-2', { ...toGapReport({ revealing: fourth, trackKey, missingRanges: [{ from: 1, to: 2 }] }), gapRequestNumber: 2 }),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId, first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([
            { msgId: first.id.msgId, reason: 'repair-exhausted' },
            { msgId: second.id.msgId, reason: 'repair-exhausted' }
        ]);
        await runtime.acceptControlMessage(
            toGapNack('control-renewal-3', { ...toGapReport({ revealing: fourth, trackKey, missingRanges: [{ from: 1, to: 2 }] }), gapRequestNumber: 3 }),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);

        expect(repairs).toEqual([first.id.msgId, second.id.msgId, first.id.msgId, second.id.msgId]);
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
                traceId: first.id.traceId,
                trackedReceiptAlgo: 'none',
                verdict: {
                    kind: 'skipped',
                    reason: 'repair-exhausted',
                    detail: `The repair of ${first.id.msgId} ran out of retransmits after 1 of 1.`
                }
            });
        expect(warnings.filter((message) => message.includes('budget'))).toEqual([]);
    });

    it('ends an unreceipted send\'s repairs for a frozen recipient at the same request as the addressee\'s, and charges a stranger nothing', async () => {
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
        const [first, second, third, fourth] = [1, 2, 3, 4].map(createFrozenOrderedMessage) as [
            ALMessage,
            ALMessage,
            ALMessage,
            ALMessage
        ];
        for (const message of [first, second, third, fourth]) {
            await enqueueOutboundOrThrow(runtime, message);
        }
        const trackKey = toALOrderingTrackKey(first)!;
        const report = (requester: string) => toGapReport({ revealing: fourth, trackKey, missingRanges: [{ from: 1, to: 2 }], requester });

        const stranger = await runtime.acceptControlMessage(toGapNack('control-gap-stranger', report('stranger')), 'peer');
        await runtime.acceptControlMessage(toGapNack('control-gap-peer-3', report('peer-3')), 'peer');
        await waitForOutboundWorkDrained(stores);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([]);
        expect(await readRepairAttempts(stores, [first, second], 'peer-3')).toEqual([1, 1]);
        expect(await readRepairAttempts(stores, [first, second], 'stranger')).toEqual([0, 0]);

        await runtime.acceptControlMessage(toGapNack('control-renewal-peer-3', { ...report('peer-3'), gapRequestNumber: 2 }), 'peer');
        await waitForOutboundWorkDrained(stores);

        expect(stranger).toEqual({ kind: 'rejected', reason: 'AL repair sender has no retained outbound obligation' });
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([
            { msgId: first.id.msgId, reason: 'repair-exhausted' },
            { msgId: second.id.msgId, reason: 'repair-exhausted' }
        ]);
    });

    it('charges a frozen recipient nothing for a relayed gap NACK unsigned or signed by another key, and charges its own signed one (ruling 19)', async () => {
        const repairs: string[] = [];
        const stores = createDefaultOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage,
            planRepairMessage,
            recipientAuthentication: {
                kind: 'signature',
                verifier: new RtcReceiptProofVerifier({ crypto: ROOM_PUBLICATION_CRYPTO, nowEpochMs: Date.now }),
                readRecipientKey: (_msg, peerId) => peerId === 'peer-3' ? ROOM_PUBLICATION_KEY : undefined
            },
            sendPreparedMessage: async (prepared) => {
                if (prepared.kind === 'repair') {
                    repairs.push(prepared.msgId!);
                }
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const [first, second, third] = [1, 2, 3].map(createFrozenOrderedMessage) as [ALMessage, ALMessage, ALMessage];
        for (const message of [first, second, third]) {
            await enqueueOutboundOrThrow(runtime, message);
        }
        const trackKey = toALOrderingTrackKey(first)!;
        const relayed = (controlMsgId: string, gapRequestNumber: number) =>
            toRelayedGapNack(controlMsgId, {
                ...toGapReport({ revealing: third, trackKey, missingRanges: [{ from: 1, to: 2 }], requester: 'relay' }),
                gapRequestNumber
            }, 'peer-3');

        const unsigned = await runtime.acceptControlMessage(relayed('relayed-unsigned', 1), 'peer');
        const otherKey = await runtime.acceptControlMessage(
            await toSignedRelayedGapNack(relayed('relayed-other-key', 2), await createAvailablePublicationCryptoFixture()),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);

        expect([unsigned.kind, otherKey.kind]).toEqual(['rejected', 'rejected']);
        expect(repairs).toEqual([]);
        expect(await readRepairAttempts(stores, [first, second], 'peer-3')).toEqual([0, 0]);

        const signed = await runtime.acceptControlMessage(
            await toSignedRelayedGapNack(relayed('relayed-signed', 3), ROOM_PUBLICATION_CRYPTO),
            'peer'
        );
        await waitForOutboundWorkDrained(stores);

        expect(signed.kind).toBe('committed');
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(await readRepairAttempts(stores, [first, second], 'peer-3')).toEqual([1, 1]);
    });

    it('charges one attempt per gap: a re-executed hint and a later frame\'s report of the same gap neither charge again nor exhaust, and write no new row', async () => {
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
        const [first, second, third, fourth] = [1, 2, 3, 4].map(createOrderedMessage) as [
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
        const retransmission = createRepairRetransmission(stores, settlements, { planOutgoingMessage, planRepairMessage });
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
        const rows = [...stores.backend.workQueue.peekKeys()].sort();

        // The hint of seq 4 reports the same gap: each sequence names its first attempt's sends, written once.
        await retransmission.retransmitFromRepairHint(fourth.id.msgId, gap, 'repair-hint-4');
        await retransmission.retransmitFromRepairHint(fourth.id.msgId, gap, 'repair-hint-4');
        await runOutboundWorkTask(runtime);
        expect(repairs).toEqual([first.id.msgId, second.id.msgId]);
        expect(await readRepairAttempts(stores, [first, second])).toEqual([1, 1]);
        expect(toSkippedRepairs(settlements)).toEqual([]);
        expect([...stores.backend.workQueue.peekKeys()].sort()).toEqual(rows);
    });

    it('a hint without ranges keeps the hint\'s identity, and the exhaustion it finds ends the message and its count', async () => {
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
        const [first, second] = [1, 2].map(createOrderedMessage) as [ALMessage, ALMessage];
        for (const message of [first, second]) {
            await enqueueOutboundOrThrow(runtime, message);
        }
        await waitForOutboundWorkDrained(stores);
        const settlements: ALOutboundSettlementFact[] = [];
        const retransmission = createRepairRetransmission(stores, settlements, { planOutgoingMessage, planRepairMessage });
        const withoutRanges: ALOutboundRepairHint = {
            trigger: 'repair',
            requestedByPeerId: 'peer-1',
            missingRanges: [],
            failedPeerIds: []
        };

        // Two such hints are two identities: the first charges one attempt, and the second finds the budget spent.
        // That exhaustion ends the message, and its count with it.
        await retransmission.retransmitFromRepairHint(first.id.msgId, withoutRanges, 'repair-hint-a');
        await runOutboundWorkTask(runtime);
        expect(await readRepairAttempts(stores, [first])).toEqual([1]);
        await retransmission.retransmitFromRepairHint(first.id.msgId, withoutRanges, 'repair-hint-b');
        await runOutboundWorkTask(runtime);

        expect(repairs).toEqual([first.id.msgId]);
        expect(toSkippedRepairs(settlements)).toEqual([{ msgId: first.id.msgId, reason: 'repair-exhausted' }]);
        expect(await readRepairAttempts(stores, [first])).toEqual([0]);
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
        const track = [40, 41, 42].map(createOrderedMessage);
        for (const message of track) {
            await enqueueOutboundOrThrow(runtime, message);
        }
        await waitForOutboundWorkDrained(stores);
        const settlements: ALOutboundSettlementFact[] = [];
        const retransmission = createRepairRetransmission(stores, settlements, { planOutgoingMessage, planRepairMessage });
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

describe('a retransmission re-admits the message it sent', () => {
    it('keeps the sent envelope\'s trace on a gap repair and on a retransmit by message id', async () => {
        const stores = createDefaultOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage,
            planRepairMessage,
            sendPreparedMessage: async () => await Promise.resolve({ status: 'sent', submissionAttempted: true })
        });
        const [first, second, third] = [1, 2, 3].map((seq) => {
            const message = createOrderedMessage(seq);
            return { ...message, id: { ...message.id, traceId: `trace-seq-${seq}` } };
        }) as [ALMessage, ALMessage, ALMessage];
        for (const message of [first, second, third]) {
            await enqueueOutboundOrThrow(runtime, message);
        }
        await waitForOutboundWorkDrained(stores);
        const readmitted: string[] = [];
        const retransmission = createRepairRetransmission(stores, [], {
            planOutgoingMessage: (msg, authority) => {
                readmitted.push(`${msg.id.msgId} ${msg.id.traceId}`);
                return planOutgoingMessage(msg, authority);
            },
            planRepairMessage: async (msg) => {
                readmitted.push(`${msg.id.msgId} ${msg.id.traceId}`);
                return await planRepairMessage(msg);
            }
        });

        await retransmission.retransmitFromRepairHint(third.id.msgId, {
            trigger: 'nack',
            requestedByPeerId: 'peer-1',
            orderingTrackKey: toALOrderingTrackKey(first)!,
            missingRanges: [{ from: 1, to: 1 }],
            failedPeerIds: []
        }, 'repair-hint-trace');
        await retransmission.retransmitByMsgId(second.id.msgId, { attemptIdentity: 'retransmit-trace' });

        expect(new Set(readmitted)).toEqual(new Set([`${first.id.msgId} trace-seq-1`, `${second.id.msgId} trace-seq-2`]));
    });
});
