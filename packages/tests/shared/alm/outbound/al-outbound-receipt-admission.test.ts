import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import type { ALOutboundAdmissionMutation } from '@shared/alm/outbound/admission/al-outbound-admission-mutations.ts';
import {
    toALOutboundRoomSentPositionKey,
    toALOutboundSentPositionKey
} from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import {
    decodeALOutboundRoomSentPositionRow,
    decodeALOutboundTrackPositionRow,
    type ALOutboundRoomSentPositionRow
} from '@shared/alm/outbound/admission/decode-al-outbound-track-position-row.ts';
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
    type SharedHeadCarrierStores
} from '../outbound-runtime-test-fixture.ts';

/** The browser session whose WS leg sends; the WS server names the recipients it routed each send to. */
const SESSION_ID = 'origin';

interface ReceiptAdmissionFixture {
    readonly backend: ALAdmissionWorkBackend;
    readonly stores: SharedHeadCarrierStores;
    readonly ws: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    /** The mutation kinds of every commit the WS pair's store made, in order. */
    readonly commits: (readonly ALOutboundAdmissionMutation['kind'][])[];
}

describe('the WS leg\'s receipt admission on a head both carriers share', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('moves each recipient an admitted receipt names to its sequence and resolves the room floor there', async () => {
        const fixture = createReceiptAdmissionFixture();
        const sends = await sendRoomBroadcasts(fixture, ['first', 'second', 'third']);
        const trackKey = toALOrderingTrackKey(sends[2]!)!;
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ seq: 3, resolvedSeq: 0 });

        expect(await fixture.ws.acceptReceipt(createServerReceipt(sends[2]!, 'admitted', ['a', 'b'])))
            .toEqual({ kind: 'committed' });

        expect(await readSharedPositions(fixture, trackKey, ['a', 'b', 'c'])).toEqual({ a: 3, b: 3, c: undefined });
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ seq: 3, resolvedSeq: 3 });
    });

    it('leaves the floor unresolved for a later sequence when the receipt resolves an earlier one', async () => {
        const fixture = createReceiptAdmissionFixture();
        const sends = await sendRoomBroadcasts(fixture, ['first', 'second']);
        const trackKey = toALOrderingTrackKey(sends[0]!)!;

        await fixture.ws.acceptReceipt(createServerReceipt(sends[0]!, 'admitted', ['a']));

        expect(await readSharedPositions(fixture, trackKey, ['a'])).toEqual({ a: 1 });
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ seq: 2, resolvedSeq: 1 });
    });

    it('keeps a recipient a later receipt already moved further, and the floor that receipt resolved', async () => {
        const fixture = createReceiptAdmissionFixture();
        const sends = await sendRoomBroadcasts(fixture, ['first', 'second']);
        const trackKey = toALOrderingTrackKey(sends[0]!)!;
        await fixture.ws.acceptReceipt(createServerReceipt(sends[1]!, 'admitted', ['a']));

        await fixture.ws.acceptReceipt(createServerReceipt(sends[0]!, 'admitted', ['a', 'b']));

        expect(await readSharedPositions(fixture, trackKey, ['a', 'b'])).toEqual({ a: 2, b: 1 });
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ seq: 2, resolvedSeq: 2 });
    });

    it('writes no position for a complete receipt: only the admitted one carries the routed audience', async () => {
        const fixture = createReceiptAdmissionFixture();
        const [send] = await sendRoomBroadcasts(fixture, ['first']);
        const trackKey = toALOrderingTrackKey(send!)!;

        expect(await fixture.ws.acceptReceipt(createServerReceipt(send!, 'complete', ['a', 'b'])))
            .toEqual({ kind: 'committed' });

        expect(fixture.commits.at(-1)).toEqual(['set-pending-ack']);
        expect(await readSharedPositions(fixture, trackKey, ['a', 'b'])).toEqual({ a: undefined, b: undefined });
        expect(await readRoomFloor(fixture, trackKey)).toEqual({ seq: 1, resolvedSeq: 0 });
    });

    it('writes no position for the admitted receipt of a send with no sequence', async () => {
        const fixture = createReceiptAdmissionFixture();
        const unsequenced = createRoomBroadcast('unsequenced', undefined);
        expect((await fixture.ws.enqueueIfAbsent(unsequenced)).message.ordering?.seq).toBeUndefined();

        expect(await fixture.ws.acceptReceipt(createServerReceipt(unsequenced, 'admitted', ['a', 'b'])))
            .toEqual({ kind: 'committed' });

        expect(fixture.commits.at(-1)).toEqual(['set-pending-ack']);
    });
});

function createReceiptAdmissionFixture(): ReceiptAdmissionFixture {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(new InMemoryQueueBox(new Map())), Date.now);
    const stores = createSharedHeadCarrierStores(SESSION_ID, backend);
    const commits: (readonly ALOutboundAdmissionMutation['kind'][])[] = [];
    const commitBundle = stores.ws.admissionStore.commitBundle.bind(stores.ws.admissionStore);
    vi.spyOn(stores.ws.admissionStore, 'commitBundle').mockImplementation(async (bundle, observation) => {
        const status = await commitBundle(bundle, observation);
        if (status === 'committed') {
            commits.push(bundle.mutations.map((mutation) => mutation.kind));
        }
        return status;
    });
    const ws = createOutboundTestRuntimeFor({
        stores: stores.ws,
        decodePreparedMessage: decodeALOutboundTransportMessage,
        planOutgoingMessage: createWsClientMintingPlanner(SESSION_ID),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    return { backend, stores, ws, commits };
}

/** Each WS room broadcast admitted in order, as its minted copy: the WS leg records nobody, so each moves the floor. */
async function sendRoomBroadcasts(fixture: ReceiptAdmissionFixture, names: readonly string[]): Promise<readonly ALMessage[]> {
    const sent: ALMessage[] = [];
    for (const name of names) {
        const result = await fixture.ws.enqueueIfAbsent(createRoomBroadcast(name, 'chat'));
        expect(result.verdict.kind, result.reason).toBe('admitted');
        sent.push(result.message);
    }
    return sent;
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
): Promise<ALOutboundRoomSentPositionRow | undefined> {
    return await fixture.backend.readWithin((session) =>
        session.read(
            toALOutboundRoomSentPositionKey(fixture.stores.headNamespace, trackKey),
            decodeALOutboundRoomSentPositionRow
        )
    );
}

/** A WS room broadcast asking its server for a receipt per recipient, on the ordering key given, or on none. */
function createRoomBroadcast(name: string, orderingKey: string | undefined): ALMessage {
    return newALBroadcastMessage(
        SESSION_ID,
        newALRoute('room.chat', ORIGIN_ROOM.groupId, name),
        'room',
        'chat.message.v1',
        { name },
        {
            groupRef: ORIGIN_ROOM,
            ttlMs: 30_000,
            ack: 'all-logical-recipients',
            ...(orderingKey === undefined ? {} : { ordering: { orderingKey } })
        }
    );
}
