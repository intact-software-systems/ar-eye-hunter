import type {
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageSendStrategy
} from '@shared-web/browser/rallar-messages.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_DELIVERY_ADMITTED_STATES, type ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { GroupPublicationTopicPermissions } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcCarrierGapAdmission } from '@shared/multicast/compute-rtc-outbound-carrier-availability.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditStampFixture, createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
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

/** One carrier admission port a send reached: the effect log every test asserts as a value. */
interface CarrierAdmission {
    readonly carrier: ALDeliveryCarrier;
    readonly message: ALMessage;
}

/** Either carrier's admission port; the RTC one also takes its carrier-gap mode, which these tests ignore. */
interface CarrierAdmissionPort {
    enqueueOutboxIfAbsent(message: ALMessage, carrierGap: RtcCarrierGapAdmission): Promise<ALOutboundEnqueueResult>;
}

const ROOM_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const GRANTED_TOPIC_ID = 'room.granted-feed';
const SESSION_PRINCIPAL_ID = 'principal-1';

const mocks = getRallarFacadeMocks();
let admissions: CarrierAdmission[] = [];

installFakeBroadcastChannelPerTest();

describe('a granted typed channel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRallarFacadeTestRuntime();
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

    it('sendRtc and a send with strategy rtc on a granted channel settle rejected with refused/unsupported and open no leg', async () => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot({ publish: true, subscribe: true })]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handles = [
            await channel.sendRtc({ text: 'rtc' }),
            await channel.send({ text: 'rtc strategy' }, { strategy: 'rtc' })
        ];

        for (const handle of handles) {
            expect((await handle.wait()).lifecycle).toMatchObject({
                state: 'rejected',
                evidence: { failure: { kind: 'refused', reason: 'unsupported' } }
            });
        }
        expect(admissions).toEqual([]);
    });

    it.each<[string, RallarTypedMessageSendStrategy]>([
        ['a granted channel\'s ws-then-rtc send never opens an RTC leg', 'ws-then-rtc'],
        ['rtc-with-ws-fallback goes straight to WS', 'rtc-with-ws-fallback']
    ])('%s', async (_name, strategy) => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot({ publish: true, subscribe: false })]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.send({ text: strategy }, { strategy });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
        expect(admissions.map(({ carrier, message }) => [carrier, message.route.topicId])).toEqual([
            ['ws', GRANTED_TOPIC_ID]
        ]);
    });

    it('a send without a cached publish grant settles rejected with refused/no-publish-grant before any leg', async () => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot({ publish: false, subscribe: true })]);
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
        setRallarFacadeRoomSnapshots([createRoomSnapshot(undefined)]);
        const channel = createRallarTestFacade().messages.room<FeedItem>(toGrantedDefinition());

        const handle = await channel.sendWs({ text: 'no row' });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'no-publish-grant' } }
        });
        expect(admissions).toEqual([]);
    });

    it('a granted channel\'s world send names no room and is refused unsupported before any leg', async () => {
        const { roomRef: _roomRef, ...definition } = { ...toGrantedDefinition(), topicId: 'app.granted-feed' };
        const channel = createRallarTestFacade().messages.channel<FeedItem>(definition);

        const handle = await channel.send({ text: 'world' }, { scope: 'world' });

        expect((await handle.wait()).lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'unsupported' } }
        });
        expect(admissions).toEqual([]);
    });

    it('a send with a cached publish grant reaches the WS leg', async () => {
        setRallarFacadeRoomSnapshots([createRoomSnapshot({ publish: true, subscribe: false })]);
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

/** The session's principal is the room's active owner; `permissions` is its grant row on the granted topic, or none. */
function createRoomSnapshot(permissions: GroupPublicationTopicPermissions | undefined): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: [SESSION_PRINCIPAL_ID] });
    return {
        ...snapshot,
        publicationGrants: permissions === undefined
            ? []
            : [{
                ...ROOM_REF,
                principalId: SESSION_PRINCIPAL_ID,
                topics: { [GRANTED_TOPIC_ID]: permissions },
                updated: createAuditStampFixture(2, 'creator')
            }]
    };
}

/** Both carriers' admission ports, admitting every send and logging it in the order the sends reached them. */
function recordCarrierAdmissions(): CarrierAdmission[] {
    const log: CarrierAdmission[] = [];
    const record = (carrier: ALDeliveryCarrier, port: CarrierAdmissionPort) => {
        port.enqueueOutboxIfAbsent = async (message) => {
            log.push({ carrier, message });
            return await Promise.resolve(toQueuedMessageAdmission(message));
        };
    };
    record('rtc', mocks.apiMiddleware.middleware.rtcRxStreamer);
    record('ws', mocks.apiMiddleware.middleware.webSocketQueueBox);
    return log;
}
