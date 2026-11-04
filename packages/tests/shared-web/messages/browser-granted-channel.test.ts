import type {
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageSendStrategy
} from '@shared-web/browser/rallar-messages.ts';
import type { ALAckMode, ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    type ALDeliveryAdmissionVerdict,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type {
    GroupPublicationGrant,
    GroupPublicationTopicPermissions
} from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRtcGrantedTopicsFixture } from '../../shared/multicast/rtc-granted-topic-reader-fixtures.ts';
import {
    createOriginOverlay,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    ORIGIN_ROOM,
    type RtcOriginOverlayFixture
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
const SUBSCRIBER: GroupPublicationTopicPermissions = { publish: false, subscribe: true };

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

    it('onRtc on a granted channel throws the unsupported issue: its RTC copies reach subscribe(handler) only', () => {
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        expect(() => channel.onRtc(() => {})).toThrow(expect.objectContaining({
            name: 'RallarValidationError',
            issues: [expect.objectContaining({
                path: '$.access',
                code: 'unsupported',
                message: 'A granted channel\'s RTC copies reach subscribe(handler) only; onRtc is not offered.'
            })]
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

    it.each<RallarTypedMessageSendStrategy>(['rtc', 'rtc-with-ws-fallback'])(
        'an ack: receiver room send under %s is admitted on RTC first, carrying its origin\'s proof and frozen to the subscribers',
        async (strategy) => {
            const crypto = await createAvailablePublicationCryptoFixture();
            wireRtcOverlay(crypto, createRoomSnapshot(PUBLISHER, crypto));
            const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

            const handle = await channel.send({ text: 'receipt' }, { strategy, ack: 'receiver' });

            expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
            expect(admissions).toMatchObject([{
                carrier: 'rtc',
                verdict: 'admitted',
                message: {
                    delivery: { ack: 'receiver' },
                    targets: { mode: 'multicast', recipientPeerIds: ['b', 'c'] },
                    proof: { alg: 'ES256', keyId: crypto.keyPair.keyId }
                }
            }]);
        }
    );

    it.each<ALAckMode>(['none', 'receiver'])('a room send under ws-then-rtc with ack: %s is admitted on WS only', async (ack) => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot(PUBLISHER, undefined)]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: 'ws-then-rtc' }, { strategy: 'ws-then-rtc', ack });

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

    it('messages.rtc.send on a topic the snapshot grants, without publish, settles rejected with refused/no-publish-grant', async () => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot({ publish: false, subscribe: true }, undefined)]);

        const handle = await createRallarTestFacade().messages.rtc.send(toLaneSend('none'));

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'no-publish-grant' } }
        });
        expect(admissions).toEqual([]);
    });

    it('messages.rtc.send on a topic the snapshot grants, asking a receipt, is admitted on RTC carrying its origin\'s proof', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        wireRtcOverlay(crypto, createRoomSnapshot(PUBLISHER, crypto));

        const handle = await createRallarTestFacade().messages.rtc.send(toLaneSend('receiver'));

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions).toMatchObject([{
            carrier: 'rtc',
            verdict: 'admitted',
            message: { delivery: { ack: 'receiver' }, proof: { alg: 'ES256', keyId: crypto.keyPair.keyId } }
        }]);
    });

    it('messages.rtc.send on a topic a granted channel declared, asking a receipt, reaches the RTC carrier', async () => {
        const facade = createRallarTestFacade();
        facade.messages.room<FeedItem>(toGrantedDefinition());

        const handle = await facade.messages.rtc.send(toLaneSend('receiver'));

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions.map(({ carrier, message }) => [carrier, message.delivery?.ack])).toEqual([['rtc', 'receiver']]);
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

    it('a raw WS send and a members channel\'s WS send on a declared granted topic naming no room are refused unsupported before any leg', async () => {
        const facade = createRallarTestFacade();
        const { roomRef: _roomRef, ...definition } = { ...toGrantedDefinition(), topicId: 'app.granted-feed' };
        facade.messages.channel<FeedItem>(definition);

        const handles = [
            await facade.messages.ws.send({
                typeId: 'room.granted-feed.v1',
                topicId: 'app.granted-feed',
                payload: { text: 'raw' },
                scope: 'world',
                ack: 'none'
            }),
            await facade.messages.channel<FeedItem>({ ...definition, access: 'members' })
                .sendWs({ text: 'members' }, { scope: 'world', ack: 'none' })
        ];

        for (const handle of handles) {
            expect((await handle.wait()).lifecycle).toMatchObject({
                state: 'rejected',
                evidence: { failure: { kind: 'refused', reason: 'unsupported' } }
            });
        }
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

    it('with no cached snapshot the RTC carrier cannot sign the send and the server decides over WS', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const overlay = wireRtcOverlay(crypto, createRoomSnapshot(PUBLISHER, crypto));
        overlay.groups.delete('room');
        setRallarFacadeRoomSnapshots([]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: 'server decides' });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions.map(({ carrier, verdict, message }) => [carrier, verdict, message.route.topicId])).toEqual([
            ['rtc', 'refused', GRANTED_TOPIC_ID],
            ['ws', 'admitted', GRANTED_TOPIC_ID]
        ]);
    });

    it('a revoke the page sees between the RTC refusal and the WS admission ends the handle rejected no-publish-grant, with no WS leg', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        wireRtcOverlay(UNAVAILABLE_PUBLICATION_CRYPTO, createRoomSnapshot(PUBLISHER, crypto));
        revokeAfterRtcAdmission(createRoomSnapshot(SUBSCRIBER, crypto));
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: 'revoked' }, { strategy: 'rtc-with-ws-fallback', ack: 'receiver' });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'no-publish-grant' } }
        });
        expect(admissions.map(({ carrier, verdict }) => [carrier, verdict])).toEqual([['rtc', 'refused']]);
    });

    it('a revoke only the server has seen ends the handed-over WS leg rejected by the server\'s no-publish-grant refusal', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        wireRtcOverlay(UNAVAILABLE_PUBLICATION_CRYPTO, createRoomSnapshot(PUBLISHER, crypto));
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());
        const handle = await channel.send({ text: 'server' }, { strategy: 'rtc-with-ws-fallback', ack: 'receiver' });
        await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });

        mocks.deliverySettlements!.ws(toServerPublishRefusal(handle.msgId));

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { relayRejection: { relay: 'trusted-server', reason: 'no-publish-grant' } }
        });
        expect(admissions.map(({ carrier, verdict }) => [carrier, verdict])).toEqual([['rtc', 'refused'], ['ws', 'admitted']]);
    });

    it('a revoke after the RTC admission ends the handle rejected at the origin\'s next retry, handing nothing to WS', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        const overlay = wireRtcOverlay(
            crypto,
            createRoomSnapshot(PUBLISHER, crypto),
            (settlement) => mocks.deliverySettlements?.rtc(settlement)
        );
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());
        const handle = await channel.send({ text: 'admitted' }, { strategy: 'rtc-with-ws-fallback', ack: 'receiver' });
        await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });

        const revoked = createRoomSnapshot(SUBSCRIBER, crypto);
        overlay.groups.accept('room', revoked);
        setRallarFacadeRoomSnapshots([revoked]);

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'no-publish-grant' }, carrierFallback: undefined }
        });
        expect(admissions.map(({ carrier, verdict }) => [carrier, verdict])).toEqual([['rtc', 'admitted']]);
    });

    it('a receipt that runs out on RTC after a revoke hands over to a WS re-admission the cached snapshot refuses', async () => {
        const crypto = await createAvailablePublicationCryptoFixture();
        wireRtcOverlay(crypto, createRoomSnapshot(PUBLISHER, crypto));
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());
        const handle = await channel.send({ text: 'exhausted' }, { strategy: 'rtc-with-ws-fallback', ack: 'receiver' });
        await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });

        setRallarFacadeRoomSnapshots([createRoomSnapshot(SUBSCRIBER, crypto)]);
        mocks.deliverySettlements!.rtc(toReceiptExhausted(handle.msgId));

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'no-publish-grant' }, carrierFallback: { reason: 'receipt-exhausted' } }
        });
        expect(admissions.map(({ carrier, verdict }) => [carrier, verdict])).toEqual([['rtc', 'admitted']]);
    });
});

function toLaneSend(ack: ALAckMode) {
    return { typeId: 'room.granted-feed.v1', topicId: GRANTED_TOPIC_ID, roomRef: ROOM_REF, payload: { text: 'lane' }, ack };
}

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
 * The room of `a`, `b` and `c`, where `b` and `c` may subscribe to the granted topic; `permissions` is `a`'s grant row
 * on it, or none, and `registered` the page key `a`'s presence row attests, or none.
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
        publicationGrants: [
            ...(permissions === undefined ? [] : [toGrantRow(SESSION_ID, permissions)]),
            toGrantRow('b', SUBSCRIBER),
            toGrantRow('c', SUBSCRIBER)
        ]
    };
}

function toGrantRow(principalId: string, permissions: GroupPublicationTopicPermissions): GroupPublicationGrant {
    return { ...ROOM_REF, principalId, topics: { [GRANTED_TOPIC_ID]: permissions }, updated: createAuditStampFixture(2, 'creator') };
}

/**
 * The page's RTC overlay over the cached room, signing with `publicationCrypto`; its admissions join the log. Its
 * accepted overlay is the one the browser's room send names.
 */
function wireRtcOverlay(
    publicationCrypto: PublicationCrypto,
    snapshot: GroupSnapshot,
    onSettlement?: (settlement: ALDeliverySettlement) => void
): RtcOriginOverlayFixture {
    setRallarFacadeRoomSnapshots([snapshot]);
    const overlay = createRtcOriginOverlayFixture({
        snapshot,
        nextHopPeerIds: ['b', 'c'],
        grantedTopics: createRtcGrantedTopicsFixture([GRANTED_TOPIC_ID]),
        publicationCrypto,
        onSettlement
    });
    const overlayId = toScopedOverlayId(ROOM_REF);
    overlay.overlays.accept(overlayId, { ...createOriginOverlay(['b', 'c']), overlayId });
    mocks.apiMiddleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent = async (message, carrierGap) => {
        const result = await overlay.manager.enqueueLegIfAbsent(message, carrierGap);
        admissions.push({ carrier: 'rtc', message: result.message, verdict: result.verdict.kind });
        return result;
    };
    return overlay;
}

/** The page's cached snapshot turns to `revoked` once the RTC carrier answered, before any fallback leg reads it. */
function revokeAfterRtcAdmission(revoked: GroupSnapshot): void {
    const port = mocks.apiMiddleware.middleware.rtcRxStreamer;
    const admit = port.enqueueOutboxIfAbsent;
    port.enqueueOutboxIfAbsent = async (message, carrierGap) => {
        const result = await admit(message, carrierGap);
        setRallarFacadeRoomSnapshots([revoked]);
        return result;
    };
}

/** The WS server's NACK for a granted send whose sender it reads without publish (D487), as its relay rejection. */
function toServerPublishRefusal(msgId: string): ALDeliverySettlement {
    return {
        kind: 'relay-rejected',
        msgId,
        carrier: 'ws',
        atMs: Date.now(),
        relayRejection: { relay: 'trusted-server', reason: 'no-publish-grant' },
        detail: 'The server relay refused the message: no-publish-grant.',
        traceId: 'trace-browser-granted-channel'
    };
}

function toReceiptExhausted(msgId: string): ALDeliverySettlement {
    return {
        kind: 'receipt-exhausted',
        msgId,
        carrier: 'rtc',
        atMs: Date.now(),
        mode: 'receiver',
        confirmedPeerIds: [],
        unconfirmedPeerIds: ['b', 'c'],
        outsideAudiencePeerIds: [],
        cause: 'budget',
        detail: 'The receipt ran out of retries after 3 of 3.',
        traceId: 'trace-browser-granted-channel'
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
