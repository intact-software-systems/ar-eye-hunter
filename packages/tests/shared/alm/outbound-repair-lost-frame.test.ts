import { afterEach, describe, expect, it, vi } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALAckMode, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import {
    createDefaultIndexedDbALOutboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { createInMemoryALAdmissionState } from '@shared/mod.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import '../../setup-browser-indexeddb.ts';
import { ORIGIN_ROOM } from '../multicast/rtc-origin-overlay-fixture.ts';
import {
    createOutboundTestRuntimeFor,
    createWsClientMintingPlanner,
    peekOutboundWorkReadyAt,
    runOutboundWorkTask
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
    readonly stores: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly written: WrittenFrame[];
    /** The message of every committed repair dispatch, as the lane's `commit-phases` diagnostic names it. */
    readonly repairCommits: string[];
}

/** What the sender holds that could still put the missing sequence on the wire. */
interface RecoveryPath {
    readonly framesWrittenAfterTheLoss: readonly WrittenFrame[];
    readonly workReadyAtMs: number | undefined;
}

const NO_RECOVERY: RecoveryPath = { framesWrittenAfterTheLoss: [], workReadyAtMs: undefined };

type StoreKind = 'memory' | 'indexeddb';

const STORE_KINDS: readonly StoreKind[] = ['memory', 'indexeddb'];

describe('a WS client\'s ordered stream whose lost sequence the server reports again', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Breaks when a repeated gap report for a sequence whose repair frame was lost finds the first attempt's
    // completed send row and writes nothing (the per-gap attempt identity, D573), while nothing else on the
    // sender is left to resend it: the server's track waits on that sequence for good.
    it.each(STORE_KINDS.flatMap((store) => (['none', 'receiver'] as const).map((ack) => [store, ack] as const)))(
        'on %s with ack %s, writes the sequence again, or keeps work that will, once its repair frame is lost',
        async (store, ack) => {
            const fixture = createLostFrameFixture(store);
            const [first, second, third] = await sendRoomStream(fixture, ['first', 'second', 'third'], ack);
            const trackKey = toALOrderingTrackKey(first!)!;
            // The loss took seq 1's frame. Seq 2 reveals the gap to the server, which reports it.
            await fixture.ws.acceptControlMessage(toServerGapNack('gap-revealed-by-2', second!, trackKey), 'peer');
            await drainOutboundWork(fixture);
            expect(fixture.written.filter((frame) => frame.seq === 1).map((frame) => frame.phase))
                .toEqual(['immediate', 'immediate']);

            // The loss took the repair frame too. Seq 3 reveals the same gap, which the server reports again.
            const writtenBeforeTheRepeat = fixture.written.length;
            await fixture.ws.acceptControlMessage(toServerGapNack('gap-revealed-by-3', third!, trackKey), 'peer');
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
});

describe('a WS client\'s receipted room send whose only frame never reaches the server', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Breaks when a `receiver` room send over WS writes no receipt row and no `ack-timeout` work at admission (the
    // server's receipts own its schedule) and the server, having admitted nothing, holds no receipt either: no
    // timer anywhere resends the message, and no gap report comes when no later frame arrives.
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

function createLostFrameFixture(store: StoreKind): LostFrameFixture {
    const written: WrittenFrame[] = [];
    const repairCommits: string[] = [];
    const stores = createCarrierStores(store);
    const ws = createOutboundTestRuntimeFor({
        stores,
        decodePreparedMessage: decodeALOutboundTransportMessage,
        planOutgoingMessage: createWsClientMintingPlanner(SESSION_ID),
        planRepairMessage: undefined,
        hopPeerIds: [SERVER_PEER_ID],
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
    return { ws, stores, written, repairCommits };
}

/** The WS client pair as the browser keys it, over a memory backend or the session's IndexedDB database. */
function createCarrierStores(store: StoreKind): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    const input = {
        namespace: `browser:ws-client:${SESSION_ID}`,
        canonicalScope: `browser-session:${SESSION_ID}`,
        orderingHeadNamespace: `browser:session-${SESSION_ID}-ordering`,
        decodePrepared: decodeALOutboundTransportMessage
    };
    return store === 'memory'
        ? createDefaultInMemoryALOutboundRuntimeStores({
            ...input,
            outboundBackend: new InMemoryAdmissionBackend(
                createInMemoryALAdmissionState(new InMemoryQueueBox(new Map())),
                Date.now
            )
        })
        : createDefaultIndexedDbALOutboundRuntimeStores({ ...input, dbName: `lost-repair-frame-${crypto.randomUUID()}` });
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

/** Runs the owner's batches until it advertises nothing due now, as the engine's wakes would. */
async function drainOutboundWork(fixture: LostFrameFixture): Promise<void> {
    for (let batch = 0; batch < 10; batch += 1) {
        await runOutboundWorkTask(fixture.ws);
        const readyAtMs = await peekOutboundWorkReadyAt(
            fixture.stores.workQueue,
            fixture.stores.admissionStore.namespace
        );
        if (readyAtMs === undefined || readyAtMs > Date.now()) {
            return;
        }
    }
}

/** The WS server's gap NACK: the frame `revealing` arrived while seq 1 of its track is still missing. */
function toServerGapNack(controlMsgId: string, revealing: ALMessage, trackKey: string): ALMessage {
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
            missingRanges: [{ from: 1, to: 1 }]
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
