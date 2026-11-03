import type {
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageSendStrategy
} from '@shared-web/browser/rallar-messages.ts';
import type { ALAckMode, ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    type ALDeliveryAdmissionVerdict,
    type ALDeliveryCarrier
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRtcGrantedTopicsFixture } from '../../shared/multicast/rtc-granted-topic-reader-fixtures.ts';
import {
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM
} from '../../shared/multicast/rtc-origin-overlay-fixture.ts';
import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO,
    type AvailablePublicationCrypto
} from '../../shared/signature/publication-crypto-fixtures.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';
import { createAuditStampFixture } from '../authoritative-group-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRallarTestFacade,
    getRallarFacadeMocks,
    resetRallarFacadeTestRuntime,
    setRallarFacadeRoomSnapshots
} from './rallar-facade-test-runtime.ts';
// After the facade runtime: its mocks must be registered before the fixture loads the modules they replace.
import { toQueuedMessageAdmission } from './browser-message-sender-fixture.ts';

interface FeedItem {
    readonly text: string;
}

/** One carrier admission port a send reached and the verdict it answered: the effect log every test asserts as a value. */
interface CarrierAdmission {
    readonly carrier: ALDeliveryCarrier;
    readonly message: ALMessage;
    readonly verdict: ALDeliveryAdmissionVerdict['kind'];
}

/** Either carrier's admission port; the RTC one also takes its carrier-gap mode. */
interface CarrierAdmissionPort {
    enqueueOutboxIfAbsent(message: ALMessage, carrierGap: RtcCarrierGapAdmission): Promise<ALOutboundEnqueueResult>;
}

/** The session is `a` of the room of `a`, `b` and `c`, the origin the RTC overlay fixture names. */
const ROOM_REF = ORIGIN_ROOM;
const SESSION_ID = 'a';
const GRANTED_TOPIC_ID = 'room.granted-feed';
const PUBLISHER: GroupPublicationTopicPermissions = { publish: true, subscribe: false };

const mocks = getRallarFacadeMocks();
let admissions: CarrierAdmission[] = [];

installFakeBroadcastChannelPerTest();

describe('a granted typed channel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRallarFacadeTestRuntime();
        mocks.apiMiddleware = createDefaultApiMiddlewareTestDouble({ session: { sessionId: SESSION_ID, clientId: SESSION_ID } });
        admissions = recordCarrierAdmissions();
    });

    it('a definition without access is refused at $.access with invalid-access', () => {
        const { access: _access, ...definition } = toGrantedDefinition();

        expect(() => createRallarTestFacade().messages.room(definition as RallarRoomMessageChannelDefinition))
            .toThrow(expect.objectContaining({
                name: 'RallarValidationError',
                issues: [expect.objectContaining({ path: '$.access', code: 'invalid-access' })]
            }));
    });

    it('a granted channel without topicId is refused at $.topicId with missing-topic-id', () => {
        const { topicId: _topicId, ...definition } = toGrantedDefinition();

        expect(() => createRallarTestFacade().messages.channel(definition)).toThrow(expect.objectContaining({
            name: 'RallarValidationError',
            issues: [expect.objectContaining({ path: '$.topicId', code: 'missing-topic-id' })]
        }));
    });

    it('onRtc on a granted channel throws the unsupported issue', () => {
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        expect(() => channel.onRtc(() => {})).toThrow(expect.objectContaining({
            name: 'RallarValidationError',
            issues: [expect.objectContaining({ path: '$.access', code: 'unsupported' })]
        }));
        expect(() => channel.onWs(() => {})).not.toThrow();
    });

    it.each<RallarTypedMessageSendStrategy>(['rtc', 'rtc-with-ws-fallback'])(
        'an ack: none room send under %s is admitted on RTC carrying its origin\'s proof',
        async (strategy) => {
            const crypto = await createAvailablePublicationCryptoFixture();
            wireRtcOverlay(crypto, createRoomSnapshot(PUBLISHER, crypto));
            const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

            const handle = await channel.send({ text: strategy }, { strategy, ack: 'none' });

            expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
            expect(admissions).toMatchObject([{
                carrier: 'rtc',
                verdict: 'admitted',
                message: { route: { topicId: GRANTED_TOPIC_ID }, proof: { alg: 'ES256', keyId: crypto.keyPair.keyId } }
            }]);
        }
    );

    it('a sendRtc with ack: none is admitted on RTC carrying its origin\'s proof', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        wireRtcOverlay(crypto, createRoomSnapshot(PUBLISHER, crypto));
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.sendRtc({ text: 'sendRtc' }, { ack: 'none' });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions).toMatchObject([{
            carrier: 'rtc',
            verdict: 'admitted',
            message: { route: { topicId: GRANTED_TOPIC_ID }, proof: { alg: 'ES256', keyId: crypto.keyPair.keyId } }
        }]);
    });

    it('an ack: receiver room send under rtc settles rejected with refused/unsupported and reaches no carrier', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        wireRtcOverlay(crypto, createRoomSnapshot(PUBLISHER, crypto));
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: 'receipt' }, { strategy: 'rtc', ack: 'receiver' });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'unsupported' } }
        });
        expect(admissions).toEqual([]);
    });

    it.each<[RallarTypedMessageSendStrategy, ALAckMode]>([
        ['rtc-with-ws-fallback', 'receiver'],
        ['ws-then-rtc', 'none'],
        ['ws-then-rtc', 'receiver']
    ])('a room send under %s with ack: %s is admitted on WS only', async (strategy, ack) => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot(PUBLISHER, undefined)]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: strategy }, { strategy, ack });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions.map(({ carrier, message }) => [carrier, message.route.topicId])).toEqual([
            ['ws', GRANTED_TOPIC_ID]
        ]);
    });

    it.each<RallarTypedMessageSendStrategy>(['rtc-with-ws-fallback', 'ws-then-rtc'])(
        'a peer-addressed send under %s takes WS',
        async (strategy) => {
            setRallarFacadeRoomSnapshots([createRoomSnapshot(PUBLISHER, undefined)]);
            const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

            const handle = await channel.send({ text: 'peer' }, { strategy, peerId: 'b', ack: 'none' });

            expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
            expect(admissions).toMatchObject([{ carrier: 'ws', message: { targets: { mode: 'unicast', toPeerId: 'b' } } }]);
        }
    );

    it('a peer-addressed send under rtc settles rejected with refused/unsupported and reaches no carrier', async () => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot(PUBLISHER, undefined)]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: 'peer' }, { strategy: 'rtc', peerId: 'b', ack: 'none' });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'unsupported' } }
        });
        expect(admissions).toEqual([]);
    });

    it.each<[string, (crypto: AvailablePublicationCrypto) => PublicationCrypto, (crypto: AvailablePublicationCrypto) => Promise<GroupSnapshot>]>([
        ['a keyless page', () => UNAVAILABLE_PUBLICATION_CRYPTO, async (crypto) => createRoomSnapshot(PUBLISHER, crypto)],
        [
            'a page its snapshot names by an older keyId',
            (crypto) => crypto,
            async () => createRoomSnapshot(PUBLISHER, await createAvailablePublicationCryptoFixture())
        ]
    ])('%s is refused by the RTC carrier before admission and the same handle is admitted on WS', async (_name, toCrypto, toSnapshot) => {
        const crypto = await createAvailablePublicationCryptoFixture();
        wireRtcOverlay(toCrypto(crypto), await toSnapshot(crypto));
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: 'fallback' }, { strategy: 'rtc-with-ws-fallback', ack: 'none' });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions.map(({ carrier, verdict, message }) => [carrier, verdict, message.id.msgId, message.proof])).toEqual([
            ['rtc', 'refused', handle.msgId, undefined],
            ['ws', 'admitted', handle.msgId, undefined]
        ]);
    });

    it('a keyless page\'s room send under rtc settles rejected with the carrier\'s refused/unsupported', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        wireRtcOverlay(UNAVAILABLE_PUBLICATION_CRYPTO, createRoomSnapshot(PUBLISHER, crypto));
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: 'keyless' }, { strategy: 'rtc', ack: 'none' });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'unsupported' } }
        });
        expect(admissions.map(({ carrier, verdict }) => [carrier, verdict])).toEqual([['rtc', 'refused']]);
    });

    it.each<[string, string, ALAckMode, GroupPublicationTopicPermissions]>([
        ['without publish', 'no-publish-grant', 'none', { publish: false, subscribe: true }],
        ['with a receipt', 'unsupported', 'receiver', PUBLISHER]
    ])('messages.rtc.send on a topic the snapshot grants, %s, settles rejected with refused/%s', async (_name, reason, ack, permissions) => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot(permissions, undefined)]);

        const handle = await createRallarTestFacade().messages.rtc.send({
            typeId: 'room.granted-feed.v1',
            topicId: GRANTED_TOPIC_ID,
            roomRef: ROOM_REF,
            payload: { text: 'lane' },
            ack
        });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason } }
        });
        expect(admissions).toEqual([]);
    });

    it('messages.rtc.send on a topic a granted channel declared, asking a receipt, settles rejected with refused/unsupported', async () => {
        const facade = createRallarTestFacade();
        facade.messages.room<FeedItem>(toGrantedDefinition());

        const handle = await facade.messages.rtc.send({
            typeId: 'room.granted-feed.v1',
            topicId: GRANTED_TOPIC_ID,
            roomRef: ROOM_REF,
            payload: { text: 'lane' },
            ack: 'receiver'
        });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'unsupported' } }
        });
        expect(admissions).toEqual([]);
    });

    it('a send without a cached publish grant settles rejected with refused/no-publish-grant before any leg', async () => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot({ publish: false, subscribe: true }, undefined)]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handles = [await channel.send({ text: 'no grant' }), await channel.sendWs({ text: 'no grant' })];

        for (const handle of handles) {
            expect((await handle.wait()).lifecycle).toMatchObject({
                state: 'rejected',
                evidence: { failure: { kind: 'refused', reason: 'no-publish-grant' } }
            });
        }
        expect(admissions).toEqual([]);
    });

    it('a send whose principal holds no grant row in the cached snapshot is refused no-publish-grant', async () => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot(undefined, undefined)]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.sendWs({ text: 'no row' });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'no-publish-grant' } }
        });
        expect(admissions).toEqual([]);
    });

    it('a granted channel\'s world send takes WS, names no room and is refused unsupported before any leg', async () => {
        const { roomRef: _roomRef, ...definition } = { ...toGrantedDefinition(), topicId: 'app.granted-feed' };
        const channel = createRallarTestFacade().messages.channel<FeedItem>(definition);

        const handle = await channel.send({ text: 'world' }, { scope: 'world', ack: 'none' });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'unsupported' } }
        });
        expect(admissions).toEqual([]);
    });

    it('a send with a cached publish grant reaches the WS leg', async () => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot(PUBLISHER, undefined)]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.sendWs({ text: 'granted' });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions).toMatchObject([{
            carrier: 'ws',
            message: { route: { topicId: GRANTED_TOPIC_ID }, targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM_REF } }
        }]);
    });

    it('with no cached snapshot the send goes to the server', async () => {
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: 'server decides' });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions.map(({ carrier, message }) => [carrier, message.route.topicId])).toEqual([
            ['ws', GRANTED_TOPIC_ID]
        ]);
    });
});

function toGrantedDefinition(): RallarRoomMessageChannelDefinition {
    return {
        topicId: GRANTED_TOPIC_ID,
        typeId: 'room.granted-feed.v1',
        roomRef: ROOM_REF,
        purpose: 'notification',
        access: 'granted'
    };
}

/**
 * The room of `a`, `b` and `c`; `permissions` is `a`'s grant row on the granted topic, or none, and `registered` the
 * page key `a`'s presence row attests, or none.
 */
function createRoomSnapshot(
    permissions: GroupPublicationTopicPermissions | undefined,
    registered: AvailablePublicationCrypto | undefined
): GroupSnapshot {
    const snapshot = createOriginSnapshot([SESSION_ID, 'b', 'c'], 3);
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) =>
            session.sessionId === SESSION_ID && registered !== undefined
                ? { ...session, publicationKey: toGroupPresencePublicationKey(registered) }
                : session
        ),
        publicationGrants: permissions === undefined
            ? []
            : [{
                ...ROOM_REF,
                principalId: SESSION_ID,
                topics: { [GRANTED_TOPIC_ID]: permissions },
                updated: createAuditStampFixture(2, 'creator')
            }]
    };
}

/**
 * The page's RTC overlay over the cached room, signing with `publicationCrypto`; its admissions join the log. Its
 * accepted overlay is the one the browser's room send names.
 */
function wireRtcOverlay(publicationCrypto: PublicationCrypto, snapshot: GroupSnapshot): void {
    setRallarFacadeRoomSnapshots([snapshot]);
    const overlay = createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: ['b', 'c'],
        grantedTopics: createRtcGrantedTopicsFixture([GRANTED_TOPIC_ID]),
        publicationCrypto
    });
    const overlayId = toScopedOverlayId(ROOM_REF);
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
