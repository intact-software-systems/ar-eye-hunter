import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import {
    newALBroadcastMessage,
    newALMulticastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type {
    ALOutboundCommitBundle,
    ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundMintingPlan } from '@shared/alm/outbound/admission/sequencing/to-al-outbound-minting-plan.ts';
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
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

import {
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM
} from '../../multicast/rtc-origin-overlay-fixture.ts';
import { createOutboundTestRuntimeFor, readOutboundTestAdmission } from '../outbound-runtime-test-fixture.ts';

/** The browser session both carriers send for, and the namespace its tracks' heads share. */
const SESSION_ID = 'a';
const SESSION_HEADS = 'browser:session-a-ordering';

const WS_CONTEXT = {
    sessionId: SESSION_ID,
    serverPeerId: 'server',
    socketOpen: true,
    nowMs: Date.now(),
    backpressured: false,
    qosProvider: toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined)
};

/** A carrier runtime planning as the WS client does: its dispatch plan, then the minting plan at a first admission. */
const WS_CLIENT_PLANNER: ALOutboundPlanner<ALOutboundTransportMessage> = (msg, authority) =>
    toALOutboundMintingPlan(
        toWsQueueBoxClientDispatchPlan(msg, { ...WS_CONTEXT, nowMs: Date.now() }),
        authority === undefined ? 'admission' : 'replan',
        SESSION_ID
    );

interface SessionCarrierStores {
    readonly ws: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly rtc: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
}

describe('one ordering head per session track, whichever carrier mints on it', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('takes 1 on one carrier, 2 on the other and 3 on the first', async () => {
        const stores = createSessionCarrierStores();
        const ws = createCarrierRuntime(stores.ws);
        const rtc = createCarrierRuntime(stores.rtc);

        const seqs = [
            await enqueueMintedSeq(ws, createRoomBroadcast('first')),
            await enqueueMintedSeq(rtc, createRoomBroadcast('second')),
            await enqueueMintedSeq(ws, createRoomBroadcast('third'))
        ];

        expect(seqs).toEqual([1, 2, 3]);
    });

    it('never mints one sequence twice when both carriers read the head at once: the later commit conflicts', async () => {
        const stores = createSessionCarrierStores();
        const wsSend = createRoomBroadcast('ws-read-first');
        const overlaySend = createRoomBroadcast('overlay-read-second');
        const wsRead = await readMintingAdmission(stores.ws, wsSend);
        const overlayRead = await readMintingAdmission(stores.rtc, overlaySend);

        expect(await stores.rtc.admissionStore.commitBundle(overlayRead)).toBe('committed');
        expect(await stores.ws.admissionStore.commitBundle(wsRead)).toBe('conflict');

        const retried = await readMintingAdmission(stores.ws, wsSend);
        expect(await stores.ws.admissionStore.commitBundle(retried)).toBe('committed');
        expect([await readSentSeq(stores.rtc, overlaySend), await readSentSeq(stores.ws, wsSend)]).toEqual([1, 2]);
    });

    it('continues on RTC at k + 1 after a fallback send\'s WS leg minted 1 to k in the start-up gap', async () => {
        const stores = createSessionCarrierStores();
        const ws = createCarrierRuntime(stores.ws);
        const origin = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b'],
            stores: stores.rtc
        });
        await enqueueMintedSeq(ws, createRoomBroadcast('gap-1'));
        await enqueueMintedSeq(ws, createRoomBroadcast('gap-2'));

        const admitted = await origin.manager.enqueueLegIfAbsent(createRoomMulticast('overlay-ready'), 'hand-over');
        await vi.waitFor(() => expect(origin.channels.b!.sent).toHaveLength(1));

        expect(admitted.verdict, admitted.reason).toMatchObject({ kind: 'admitted' });
        expect(admitted.message.ordering?.seq).toBe(3);
        expect(origin.channels.b!.sent.map((sent) => sent.ordering?.seq)).toEqual([3]);
    });
});

/** Both carriers' durable pairs of one session: their own namespaces over one store, one namespace for heads. */
function createSessionCarrierStores(): SessionCarrierStores {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(new InMemoryQueueBox(new Map())), Date.now);
    const createCarrierStores = (carrier: string) =>
        createDefaultInMemoryALOutboundRuntimeStores({
            outboundBackend: backend,
            namespace: `browser:${carrier}:${SESSION_ID}`,
            canonicalScope: `browser-session:${SESSION_ID}`,
            orderingHeadNamespace: SESSION_HEADS,
            decodePrepared: decodeALOutboundTransportMessage
        });
    return { ws: createCarrierStores('ws-client'), rtc: createCarrierStores('rtc-overlay') };
}

function createCarrierRuntime(
    stores: ALOutboundRuntimeStores<ALOutboundTransportMessage>
): ALOutboundMessageRuntime<ALOutboundTransportMessage> {
    return createOutboundTestRuntimeFor({
        stores,
        decodePreparedMessage: decodeALOutboundTransportMessage,
        planOutgoingMessage: WS_CLIENT_PLANNER,
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
}

/**
 * One carrier's admission read up to its commit, as its planner asks: the store-level phases a runtime runs under
 * the session's commit lock, here driven apart so two carriers read one head before either commits.
 */
async function readMintingAdmission(
    stores: ALOutboundRuntimeStores<ALOutboundTransportMessage>,
    message: ALMessage
): Promise<ALOutboundCommitBundle<ALOutboundTransportMessage>> {
    return await readOutboundTestAdmission({
        store: stores.admissionStore,
        message,
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: () => Date.now() },
        planner: WS_CLIENT_PLANNER
    });
}

async function readSentSeq(
    stores: ALOutboundRuntimeStores<ALOutboundTransportMessage>,
    message: ALMessage
): Promise<number | undefined> {
    return (await stores.admissionStore.readSentMessage(message.id.msgId))?.msg.ordering?.seq;
}

async function enqueueMintedSeq(
    runtime: Pick<ALOutboundMessageRuntime<ALOutboundTransportMessage>, 'enqueueIfAbsent'>,
    message: ALMessage
): Promise<number | undefined> {
    const result = await runtime.enqueueIfAbsent(message);
    expect(result.verdict.kind, result.reason).toBe('admitted');
    return result.message.ordering?.seq;
}

/** A WS room broadcast of the session on the ordering key `chat`, asking its outbound for the sequence. */
function createRoomBroadcast(name: string): ALMessage {
    return newALBroadcastMessage(
        SESSION_ID,
        newALRoute('room.chat', ORIGIN_ROOM.groupId, name),
        'room',
        'chat.message.v1',
        { name },
        { groupRef: ORIGIN_ROOM, ttlMs: 30_000, ordering: { orderingKey: 'chat' } }
    );
}

/** The RTC room multicast of the session on the same track. */
function createRoomMulticast(name: string): ALMessage {
    return newALMulticastMessage(
        SESSION_ID,
        newALRoute('room.chat', ORIGIN_ROOM.groupId, name),
        ORIGIN_ROOM,
        'chat.message.v1',
        { name },
        { ttlMs: 30_000, orderingKey: 'chat' }
    );
}
