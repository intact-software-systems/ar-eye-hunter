import type { RallarRoomMessageChannelDefinition } from '@shared-web/browser/rallar-messages.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '@shared/al-contracts/al-control-value-codec.ts';
import { AL_DELIVERY_ADMITTED_STATES, type ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM
} from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import {
    createAvailablePublicationCryptoFixture,
    ROOM_PUBLICATION_CRYPTO
} from '../../shared/signature/publication-crypto-fixtures.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRallarTestFacade,
    getRallarFacadeMocks,
    resetRallarFacadeTestRuntime,
    setRallarFacadeRoomSnapshots
} from './rallar-facade-test-runtime.ts';
// After the facade runtime: its mocks must be registered before the fixture loads the modules they replace.
import { toQueuedMessageAdmission } from './browser-message-sender-fixture.ts';

interface ChatLine {
    readonly text: string;
}

/** One carrier admission port a send reached and the verdict it answered, in the order the sends reached them. */
interface CarrierAdmission {
    readonly carrier: ALDeliveryCarrier;
    readonly message: ALMessage;
    readonly verdict: ALDeliveryAdmissionVerdict['kind'];
}

interface CarrierAdmissionPort {
    enqueueOutboxIfAbsent(message: ALMessage, carrierGap: RtcCarrierGapAdmission): Promise<ALOutboundEnqueueResult>;
}

/** The session is `a` of the room of `a`, `b` and `c`, each registering the fixture's room key. */
const SESSION_ID = 'a';

const mocks = getRallarFacadeMocks();
let admissions: CarrierAdmission[] = [];

installFakeBroadcastChannelPerTest();

/**
 * D756: the RTC leg of an ordinary room send that asks a `receiver` receipt is signed with the page key, and refused
 * `unsupported` before admission while the page's snapshot does not yet name that key, so its fallback carrier takes it.
 */
describe('the RTC leg of a receipted members room send', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRallarFacadeTestRuntime();
        mocks.apiMiddleware = createDefaultApiMiddlewareTestDouble({ session: { sessionId: SESSION_ID, clientId: SESSION_ID } });
        admissions = recordCarrierAdmissions();
    });

    it('is admitted on RTC carrying its origin\'s proof once the page\'s snapshot names its key', async () => {
        wireRtcOverlay(ROOM_PUBLICATION_CRYPTO);
        const channel = createRallarTestFacade().messages.room<ChatLine>(CHAT_DEFINITION);

        const handle = await channel.send({ text: 'signed' }, { strategy: 'rtc-with-ws-fallback', ack: 'receiver' });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions).toMatchObject([{
            carrier: 'rtc',
            verdict: 'admitted',
            message: { delivery: { ack: 'receiver' }, proof: { alg: 'ES256', keyId: ROOM_PUBLICATION_CRYPTO.keyPair.keyId } }
        }]);
    });

    it('under rtc-with-ws-fallback, before the page\'s snapshot names its key, is refused by RTC and admitted on WS unsigned', async () => {
        wireRtcOverlay(await createAvailablePublicationCryptoFixture());
        const channel = createRallarTestFacade().messages.room<ChatLine>(CHAT_DEFINITION);

        const handle = await channel.send({ text: 'key window' }, { strategy: 'rtc-with-ws-fallback', ack: 'receiver' });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions.map(({ carrier, verdict, message }) => [carrier, verdict, message.id.msgId, message.proof])).toEqual([
            ['rtc', 'refused', handle.msgId, undefined],
            ['ws', 'admitted', handle.msgId, undefined]
        ]);
    });

    it('under rtc alone, before the page\'s snapshot names its key, settles rejected with the carrier\'s refused/unsupported', async () => {
        wireRtcOverlay(await createAvailablePublicationCryptoFixture());
        const channel = createRallarTestFacade().messages.room<ChatLine>(CHAT_DEFINITION);

        const handle = await channel.send({ text: 'key window' }, { strategy: 'rtc', ack: 'receiver' });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'unsupported' } }
        });
        expect(admissions.map(({ carrier, verdict }) => [carrier, verdict])).toEqual([['rtc', 'refused']]);
    });

    it('asking no receipt, before the page\'s snapshot names its key, is admitted on RTC unsigned', async () => {
        wireRtcOverlay(await createAvailablePublicationCryptoFixture());
        const channel = createRallarTestFacade().messages.room<ChatLine>(CHAT_DEFINITION);

        const handle = await channel.send({ text: 'unreceipted' }, { strategy: 'rtc', ack: 'none' });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions.map(({ carrier, verdict, message }) => [carrier, verdict, message.proof])).toEqual([
            ['rtc', 'admitted', undefined]
        ]);
    });
});

const CHAT_DEFINITION: RallarRoomMessageChannelDefinition = {
    topicId: 'room.chat',
    typeId: 'room.chat.v1',
    roomRef: ORIGIN_ROOM,
    purpose: 'notification',
    access: 'members'
};

/** The page's RTC overlay over the cached room of `a`, `b` and `c`, signing with `publicationCrypto`. */
function wireRtcOverlay(publicationCrypto: PublicationCrypto): void {
    const snapshot = createOriginSnapshot([SESSION_ID, 'b', 'c'], 3);
    setRallarFacadeRoomSnapshots([snapshot]);
    const overlay = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['b', 'c'], publicationCrypto });
    const overlayId = toScopedOverlayId(ORIGIN_ROOM);
    overlay.overlays.accept(overlayId, { ...createOriginOverlay(['b', 'c']), overlayId });
    mocks.apiMiddleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent = async (message, carrierGap) => {
        const result = await overlay.manager.enqueueLegIfAbsent(message, carrierGap);
        admissions.push({ carrier: 'rtc', message: result.message, verdict: result.verdict.kind });
        return result;
    };
}

/** Both carriers' admission ports, admitting every send and logging it in the order the sends reached them. */
function recordCarrierAdmissions(): CarrierAdmission[] {
    const log: CarrierAdmission[] = [];
    const record = (carrier: ALDeliveryCarrier, port: CarrierAdmissionPort) => {
        port.enqueueOutboxIfAbsent = async (message) => {
            const result = toQueuedMessageAdmission(message);
            log.push({ carrier, message, verdict: result.verdict.kind });
            return await Promise.resolve(result);
        };
    };
    record('rtc', mocks.apiMiddleware.middleware.rtcRxStreamer);
    record('ws', mocks.apiMiddleware.middleware.webSocketQueueBox);
    return log;
}
