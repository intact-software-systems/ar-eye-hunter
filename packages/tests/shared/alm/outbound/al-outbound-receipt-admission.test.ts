import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    newALBroadcastMessage,
    newALRoute,
    type ALAckMode,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import type { ALOutboundAdmissionMutation } from '@shared/alm/outbound/admission/al-outbound-admission-mutations.ts';
import {
    toALOutboundRoomSentFloorKey,
    toALOutboundSentPositionKey
} from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import { decodeALOutboundTrackPositionRow } from '@shared/alm/outbound/admission/decode-al-outbound-track-position-row.ts';
import {
    decodeALOutboundRoomSentFloorRow,
    type ALOutboundRoomSentFloorRow
} from '@shared/alm/outbound/admission/sequencing/al-outbound-room-sent-floor.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { createInMemoryALAdmissionState } from '@shared/mod.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import { ORIGIN_ROOM } from '../../multicast/rtc-origin-overlay-fixture.ts';
import {
    createOutboundTestRuntimeFor,
    createServerReceipt,
    createSharedHeadCarrierStores,
    createWsClientMintingPlanner,
    readOutboundTestAdmission,
    type SharedHeadCarrierStores
} from '../outbound-runtime-test-fixture.ts';

/** The browser session whose WS leg sends; the WS server names the recipients it routed each send to. */
const SESSION_ID = 'origin';
const WS_CLIENT_PLANNER = createWsClientMintingPlanner(SESSION_ID);

/** One commit the WS pair's store attempted: the mutations it carried and how it ended. */
interface RecordedCommit {
    readonly kinds: readonly ALOutboundAdmissionMutation['kind'][];
    readonly status: 'committed' | 'conflict' | 'expired';
}

interface ReceiptAdmissionFixture {
    readonly backend: ALAdmissionWorkBackend;
    readonly stores: SharedHeadCarrierStores;
    readonly ws: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    readonly commits: RecordedCommit[];
    /** Runs once, just before the WS pair's next commit: another writer landing between its read and its commit. */
    readonly beforeNextCommit: (() => Promise<void>)[];
}

describe('the WS leg\'s receipt admission on a head both carriers share', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('moves each recipient an admitted receipt names to its sequence and stops the floor waiting on it', async () => {
        const fixture = createReceiptAdmissionFixture();
        const sends = await sendRoomBroadcasts(fixture, ['first', 'second', 'third']);
        const trackKey = toALOrderingTrackKey(sends[2]!)!;
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ unreceiptedSeq: 0, pendingReceiptSeqs: [1, 2, 3] });

        expect(await fixture.ws.acceptReceipt(createServerReceipt(sends[2]!, 'admitted', ['a', 'b'])))
            .toEqual({ kind: 'committed' });

        expect(await readSharedPositions(fixture, trackKey, ['a', 'b', 'c'])).toEqual({ a: 3, b: 3, c: undefined });
        // 1 and 2 are still on their way to an audience no receipt has named.
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ unreceiptedSeq: 0, pendingReceiptSeqs: [1, 2] });
    });

    it('keeps a recipient a later receipt already moved further, and the floor empties as each receipt lands', async () => {
        const fixture = createReceiptAdmissionFixture();
        const sends = await sendRoomBroadcasts(fixture, ['first', 'second']);
        const trackKey = toALOrderingTrackKey(sends[0]!)!;
        await fixture.ws.acceptReceipt(createServerReceipt(sends[1]!, 'admitted', ['a']));
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ unreceiptedSeq: 0, pendingReceiptSeqs: [1] });

        await fixture.ws.acceptReceipt(createServerReceipt(sends[0]!, 'admitted', ['a', 'b']));

        expect(await readSharedPositions(fixture, trackKey, ['a', 'b'])).toEqual({ a: 2, b: 1 });
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ unreceiptedSeq: 0, pendingReceiptSeqs: [] });
    });

    it('writes the recipients\' rows but leaves the floor alone for a sequence a send with no receipt already covers', async () => {
        const fixture = createReceiptAdmissionFixture();
        const [receipted] = await sendRoomBroadcasts(fixture, ['receipted']);
        await sendRoomBroadcasts(fixture, ['unreceipted'], 'none');
        const trackKey = toALOrderingTrackKey(receipted!)!;
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ unreceiptedSeq: 2, pendingReceiptSeqs: [] });

        await fixture.ws.acceptReceipt(createServerReceipt(receipted!, 'admitted', ['a']));

        expect(fixture.commits.at(-1)).toEqual({ kinds: ['set-pending-ack', 'set-sent-position'], status: 'committed' });
        expect(await readSharedPositions(fixture, trackKey, ['a'])).toEqual({ a: 1 });
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ unreceiptedSeq: 2, pendingReceiptSeqs: [] });
    });

    it('re-reads the floor when the other carrier moved it between the receipt\'s read and its commit', async () => {
        const fixture = createReceiptAdmissionFixture();
        const sends = await sendRoomBroadcasts(fixture, ['first', 'second']);
        const trackKey = toALOrderingTrackKey(sends[0]!)!;
        fixture.beforeNextCommit.push(() => commitRtcPairMint(fixture.stores, createRoomBroadcast('rtc-3', 'chat')));

        expect(await fixture.ws.acceptReceipt(createServerReceipt(sends[1]!, 'admitted', ['a'])))
            .toEqual({ kind: 'committed' });

        expect(fixture.commits.slice(-2).map((commit) => commit.status)).toEqual(['conflict', 'committed']);
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ unreceiptedSeq: 0, pendingReceiptSeqs: [1, 3] });
    });

    it('writes no position for a complete receipt: only the admitted one carries the routed audience', async () => {
        const fixture = createReceiptAdmissionFixture();
        const [send] = await sendRoomBroadcasts(fixture, ['first']);
        const trackKey = toALOrderingTrackKey(send!)!;

        expect(await fixture.ws.acceptReceipt(createServerReceipt(send!, 'complete', ['a', 'b'])))
            .toEqual({ kind: 'committed' });

        expect(fixture.commits.at(-1)).toEqual({ kinds: ['set-pending-ack'], status: 'committed' });
        expect(await readSharedPositions(fixture, trackKey, ['a', 'b'])).toEqual({ a: undefined, b: undefined });
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ unreceiptedSeq: 0, pendingReceiptSeqs: [1] });
    });

    it('writes no position for the admitted receipt of a send with no sequence', async () => {
        const fixture = createReceiptAdmissionFixture();
        const unsequenced = createRoomBroadcast('unsequenced', undefined);
        expect((await fixture.ws.enqueueIfAbsent(unsequenced)).message.ordering?.seq).toBeUndefined();

        expect(await fixture.ws.acceptReceipt(createServerReceipt(unsequenced, 'admitted', ['a', 'b'])))
            .toEqual({ kind: 'committed' });

        expect(fixture.commits.at(-1)).toEqual({ kinds: ['set-pending-ack'], status: 'committed' });
    });
});

function createReceiptAdmissionFixture(): ReceiptAdmissionFixture {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(new InMemoryQueueBox(new Map())), Date.now);
    const stores = createSharedHeadCarrierStores(SESSION_ID, backend);
    const commits: RecordedCommit[] = [];
    const beforeNextCommit: (() => Promise<void>)[] = [];
    const commitBundle = stores.ws.admissionStore.commitBundle.bind(stores.ws.admissionStore);
    vi.spyOn(stores.ws.admissionStore, 'commitBundle').mockImplementation(async (bundle, observation) => {
        await beforeNextCommit.shift()?.();
        const status = await commitBundle(bundle, observation);
        commits.push({ kinds: bundle.mutations.map((mutation) => mutation.kind), status });
        return status;
    });
    const ws = createOutboundTestRuntimeFor({
        stores: stores.ws,
        decodePreparedMessage: decodeALOutboundTransportMessage,
        planOutgoingMessage: WS_CLIENT_PLANNER,
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    return { backend, stores, ws, commits, beforeNextCommit };
}

/** Each WS room broadcast admitted in order, as its minted copy: the WS leg records nobody, so each moves the floor. */
async function sendRoomBroadcasts(
    fixture: ReceiptAdmissionFixture,
    names: readonly string[],
    ack: ALAckMode = 'all-logical-recipients'
): Promise<readonly ALMessage[]> {
    const sent: ALMessage[] = [];
    for (const name of names) {
        const result = await fixture.ws.enqueueIfAbsent(createRoomBroadcast(name, 'chat', ack));
        expect(result.verdict.kind, result.reason).toBe('admitted');
        sent.push(result.message);
    }
    return sent;
}

/** A receipted send the RTC pair mints on the shared head and records nobody for, committed outside any runtime. */
async function commitRtcPairMint(stores: SharedHeadCarrierStores, message: ALMessage): Promise<void> {
    const bundle = await readOutboundTestAdmission({
        store: stores.rtc.admissionStore,
        message,
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: () => Date.now() },
        planner: WS_CLIENT_PLANNER
    });
    expect(await stores.rtc.admissionStore.commitBundle(bundle)).toBe('committed');
}

async function readSharedPositions(
    fixture: ReceiptAdmissionFixture,
    trackKey: string,
    recipientPeerIds: readonly string[]
): Promise<Readonly<Record<string, number | undefined>>> {
    const positions = await fixture.backend.readWithin((session) =>
        Promise.all(recipientPeerIds.map((recipientPeerId) =>
            session.read(
                toALOutboundSentPositionKey(fixture.stores.headNamespace, trackKey, recipientPeerId),
                decodeALOutboundTrackPositionRow
            )
        ))
    );
    return Object.fromEntries(recipientPeerIds.map((recipientPeerId, index) => [recipientPeerId, positions[index]?.seq]));
}

async function readRoomFloor(
    fixture: ReceiptAdmissionFixture,
    trackKey: string
): Promise<ALOutboundRoomSentFloorRow | undefined> {
    return await fixture.backend.readWithin((session) =>
        session.read(
            toALOutboundRoomSentFloorKey(fixture.stores.headNamespace, trackKey),
            decodeALOutboundRoomSentFloorRow
        )
    );
}

/** A WS room broadcast with the receipt mode given, on the ordering key given or on none. */
function createRoomBroadcast(
    name: string,
    orderingKey: string | undefined,
    ack: ALAckMode = 'all-logical-recipients'
): ALMessage {
    return newALBroadcastMessage(
        SESSION_ID,
        newALRoute('room.chat', ORIGIN_ROOM.groupId, name),
        'room',
        'chat.message.v1',
        { name },
        {
            groupRef: ORIGIN_ROOM,
            ttlMs: 30_000,
            ack,
            ...(orderingKey === undefined ? {} : { ordering: { orderingKey } })
        }
    );
}
