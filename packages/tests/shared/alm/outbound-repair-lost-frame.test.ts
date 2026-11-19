import { afterEach, describe, expect, it, vi } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundRepairRequesterKey } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';

import '../../setup-browser-indexeddb.ts';
import { ORIGIN_ROOM } from '../multicast/rtc-origin-overlay-fixture.ts';
import {
    createOutboundTestRuntimeFor,
    createWsClientCarrierStores,
    createWsClientMintingPlanner,
    drainOutboundWorkDueNow,
    peekOutboundWorkReadyAt,
    type WsClientCarrierStoreKind,
    type WsClientCarrierStores
} from './outbound-runtime-test-fixture.ts';

import { toTestALNackPayload } from '../../al-control-test-payloads.ts';

/** The WS client's session, and the WS server it names as its one hop, as `WsQueueBoxClientService` composes it. */
const SESSION_ID = 'origin';
const SERVER_PEER_ID = 'server';

/** One frame the WS client wrote to its socket: whether the server got it is the loss's decision, not the sender's. */
interface WrittenFrame {
    readonly seq: number | undefined;
    readonly phase: string;
}

interface LostFrameFixture {
    readonly ws: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    readonly stores: WsClientCarrierStores;
    readonly written: WrittenFrame[];
    /** The message of every committed repair dispatch, as the lane's `commit-phases` diagnostic names it. */
    readonly repairCommits: string[];
    /** Every admission the lane settled skipped, by message and reason. */
    readonly skipped: SkippedAdmission[];
}

interface SkippedAdmission {
    readonly msgId: string;
    readonly reason: string;
}

/** What the sender holds that could still put the missing sequence on the wire. */
interface RecoveryPath {
    readonly framesWrittenAfterTheLoss: readonly WrittenFrame[];
    readonly workReadyAtMs: number | undefined;
}

const NO_RECOVERY: RecoveryPath = { framesWrittenAfterTheLoss: [], workReadyAtMs: undefined };

const STORE_KINDS: readonly WsClientCarrierStoreKind[] = ['memory', 'indexeddb'];

describe('a WS client\'s ordered stream whose lost sequence the server reports again', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Breaks when a repeated gap report for a sequence whose repair frame was lost finds the first attempt's
    // completed send row and writes nothing (the per-gap attempt identity, D573), while nothing else on the
    // sender is left to resend it: the server's track waits on that sequence for good.
    it.each(STORE_KINDS.map((store) => [store, 'receiver'] as const))(
        'on %s with ack %s, writes the sequence again, or keeps work that will, once its repair frame is lost',
        async (store, ack) => {
            const fixture = createLostFrameFixture(store);
            const [first, second, third] = await sendRoomStream(fixture, ['first', 'second', 'third'], ack);
            const trackKey = toALOrderingTrackKey(first!)!;
            // The loss took seq 1's frame. Seq 2 reveals the gap to the server, which reports it.
            await fixture.ws.acceptControlMessage(toServerGapNack('gap-revealed-by-2', second!, trackKey, 1), 'peer');
            await drainOutboundWork(fixture);
            expect(fixture.written.filter((frame) => frame.seq === 1).map((frame) => frame.phase))
                .toEqual(['immediate', 'immediate']);

            // The loss took the repair frame too. Seq 3 reveals the same gap, which the server reports again.
            const writtenBeforeTheRepeat = fixture.written.length;
            await fixture.ws.acceptControlMessage(toServerGapNack('gap-revealed-by-3', third!, trackKey, 1), 'peer');
            await drainOutboundWork(fixture);
            // The repeat is admitted and its repair of seq 1 commits, as the lane's nineteen did.
            expect(fixture.repairCommits.filter((msgId) => msgId === first!.id.msgId)).toHaveLength(2);

            const recovery: RecoveryPath = {
                framesWrittenAfterTheLoss: fixture.written.slice(writtenBeforeTheRepeat).filter((frame) => frame.seq === 1),
                workReadyAtMs: await peekOutboundWorkReadyAt(fixture.stores.workQueue, fixture.stores.admissionStore.namespace)
            };
            expect(recovery, 'no frame of seq 1 is written again and no work is pending to write one')
                .not.toEqual(NO_RECOVERY);
        }
    );

    it.each(STORE_KINDS)(
        'on %s, a sender given a request with the next number writes the sequence again, and nothing more for the same number',
        async (store) => {
            const fixture = createLostFrameFixture(store);
            const [first, second, third] = await sendRoomStream(fixture, ['first', 'second', 'third'], 'none');
            const trackKey = toALOrderingTrackKey(first!)!;
            const seqOneFrames = () => fixture.written.filter((frame) => frame.seq === 1).length;
            await fixture.ws.acceptControlMessage(toServerGapNack('gap-by-2', second!, trackKey, 1), 'peer');
            await drainOutboundWork(fixture);
            expect(seqOneFrames()).toBe(2);
            await fixture.ws.acceptControlMessage(toServerGapNack('gap-by-3', third!, trackKey, 1), 'peer');
            await drainOutboundWork(fixture);
            expect(seqOneFrames()).toBe(2);
            await fixture.ws.acceptControlMessage(toServerGapNack('renewal-2', third!, trackKey, 2), 'peer');
            await drainOutboundWork(fixture);
            expect(seqOneFrames()).toBe(3);
            await fixture.ws.acceptControlMessage(toServerGapNack('renewal-2-again', third!, trackKey, 2), 'peer');
            await drainOutboundWork(fixture);
            expect(seqOneFrames()).toBe(3);
            for (const [controlId, number] of [['renewal-3', 3], ['renewal-4', 4], ['renewal-5', 5]] as const) {
                await fixture.ws.acceptControlMessage(toServerGapNack(controlId, third!, trackKey, number), 'peer');
                await drainOutboundWork(fixture);
            }
            expect(seqOneFrames()).toBe(5);
            expect(fixture.skipped).toEqual([{ msgId: first!.id.msgId, reason: 'repair-exhausted' }]);
        }
    );
});

describe('a WS client\'s message whose store holds a repair-attempt row a previous build wrote', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Breaks when the per-requester row shares the previous build's key: its strict decoder refuses the old row,
    // and every repair of the message throws until the row ends.
    it.each(STORE_KINDS)('on %s, admits a gap request, charges its requester 1 under the new row and writes the repair frame', async (store) => {
        const fixture = createLostFrameFixture(store);
        const [first, second] = await sendRoomStream(fixture, ['first', 'second'], 'none');
        const namespace = fixture.stores.admissionStore.namespace;
        await fixture.stores.backend.write(async (tx) => {
            await tx.set(`${namespace}:repair-attempt:${first!.id.msgId}`, { msgId: first!.id.msgId, attempts: 1 }, Date.now() + 60_000);
        });

        const admitted = await fixture.ws.acceptControlMessage(toServerGapNack('gap-by-2', second!, toALOrderingTrackKey(first!)!, 1), 'peer');
        await drainOutboundWork(fixture);

        expect(admitted.kind).toBe('committed');
        expect(fixture.written.filter((frame) => frame.seq === 1)).toHaveLength(2);
        const read = await fixture.stores.admissionStore.readOutgoingMessage({
            msg: first!,
            planner: createWsClientMintingPlanner(SESSION_ID),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        expect(read.repairAttempt?.attemptsByRequester).toEqual({
            [toALOutboundRepairRequesterKey({ requestedByPeerId: SERVER_PEER_ID })]: 1
        });
    });
});

describe('a WS client\'s receipted room send whose only frame never reaches the server', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Breaks when a `receiver` room send over WS keeps no first-hop wait and no `first-hop-timeout` work at admission:
    // the server, having admitted nothing, holds no receipt, so nothing resends the message, and no gap report comes
    // when no later frame arrives.
    it.each(STORE_KINDS)('on %s, keeps work pending to retry it before its message deadline', async (store) => {
        const fixture = createLostFrameFixture(store);
        await sendRoomStream(fixture, ['only'], 'receiver');
        expect(fixture.written.map((frame) => frame.seq)).toEqual([1]);

        const workReadyAtMs = await peekOutboundWorkReadyAt(
            fixture.stores.workQueue,
            fixture.stores.admissionStore.namespace
        );

        expect(workReadyAtMs, 'the sender holds no work that could resend the lost send').toBeDefined();
    });
});

function createLostFrameFixture(store: WsClientCarrierStoreKind): LostFrameFixture {
    const written: WrittenFrame[] = [];
    const repairCommits: string[] = [];
    const skipped: SkippedAdmission[] = [];
    const stores = createWsClientCarrierStores(SESSION_ID, store);
    const ws = createOutboundTestRuntimeFor({
        stores,
        decodePreparedMessage: decodeALOutboundTransportMessage,
        planOutgoingMessage: createWsClientMintingPlanner(SESSION_ID),
        planRepairMessage: undefined,
        hopPeerIds: [SERVER_PEER_ID],
        settlements: (settlement) => {
            if (settlement.kind === 'admission' && settlement.verdict.kind === 'skipped') {
                skipped.push({ msgId: settlement.msgId, reason: settlement.verdict.reason });
            }
        },
        diagnostics: (event) => {
            if (event.kind === 'commit-phases' && event.origin === 'repair' && event.commitOutcome === 'committed') {
                repairCommits.push(event.msgId);
            }
        },
        // A dropped frame leaves the socket as a sent one does: the loss is in transit, after the write.
        sendPreparedMessage: async (_prepared, phase, lifecycle) => {
            written.push({ seq: lifecycle.canonicalMessage.ordering?.seq, phase });
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { ws, stores, written, repairCommits, skipped };
}

/** Each send admitted in order as its minted copy, and its first frame written. */
async function sendRoomStream(
    fixture: LostFrameFixture,
    names: readonly string[],
    ack: ALAckMode
): Promise<readonly ALMessage[]> {
    const sent: ALMessage[] = [];
    for (const name of names) {
        const result = await fixture.ws.enqueueIfAbsent(createOrderedRoomBroadcast(name, ack));
        expect(result.verdict.kind, result.reason).toBe('admitted');
        sent.push(result.message);
    }
    await drainOutboundWork(fixture);
    return sent;
}

async function drainOutboundWork(fixture: LostFrameFixture): Promise<void> {
    await drainOutboundWorkDueNow(fixture.ws, fixture.stores);
}

/** The WS server's gap NACK, its request `gapRequestNumber` for seq 1: the frame `revealing` arrived while seq 1 is missing. */
function toServerGapNack(
    controlMsgId: string,
    revealing: ALMessage,
    trackKey: string,
    gapRequestNumber: number
): ALMessage {
    return newALNackControlMessage(
        { v: 4, msgId: controlMsgId, ts: 1, senderId: SERVER_PEER_ID, traceId: 'trace-outbound-repair-lost-frame' },
        toTestALNackPayload({
            msgId: revealing.id.msgId,
            fromPeerId: SERVER_PEER_ID,
            logicalRecipientPeerId: SERVER_PEER_ID,
            toPeerId: SESSION_ID,
            reason: 'gap',
            observedAtEpochMs: 1,
            orderingKey: trackKey,
            expectedSeq: 1,
            missingRanges: [{ from: 1, to: 1 }],
            gapRequestNumber
        })
    );
}

function createOrderedRoomBroadcast(name: string, ack: ALAckMode): ALMessage {
    return newALBroadcastMessage(
        SESSION_ID,
        newALRoute('room.stream', ORIGIN_ROOM.groupId, name),
        'room',
        'stream.message.v1',
        { name },
        { groupRef: ORIGIN_ROOM, ttlMs: 30_000, reliability: 'at-least-once', ack, ordering: { orderingKey: 'stream' } }
    );
}
