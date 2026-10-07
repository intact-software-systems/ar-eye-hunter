import type { RallarTypedMessageSendStrategy } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_DELIVERY_ADMITTED_STATES, type ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import {
    createRallarTestFacade,
    getRallarFacadeMocks,
    resetRallarFacadeTestRuntime,
    setRallarFacadeRoomSnapshots
} from './rallar-facade-test-runtime.ts';

const ROOM_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const PRINCIPAL_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'principal-1' };
const WORLD_TOPIC_ID = 'app.chat';
const UNSUPPORTED_VERDICT: ALDeliveryAdmissionVerdict = {
    kind: 'refused',
    reason: 'unsupported',
    detail: 'RTC carries room audiences only: a world broadcast is unsupported'
};

const mocks = getRallarFacadeMocks();
let rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
let webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);

installFakeBroadcastChannelPerTest();

describe('the routed carrier of a world send', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRallarFacadeTestRuntime();
        rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
        webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);
        setRallarFacadeRoomSnapshots([createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: ['session-1', 'peer-1'] })]);
    });

    it.each<RallarTypedMessageSendStrategy>(['rtc-with-ws-fallback', 'ws-then-rtc'])(
        'admits a world send on %s over WS at once, with no RTC leg and no fallback evidence',
        async (strategy) => {
            const handle = await createRoomChannel(createRallarTestFacade(), WORLD_TOPIC_ID).send({ text: 'world' }, { strategy, scope: 'world' });

            const { lifecycle } = await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });

            expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0]![0]).toMatchObject({
                route: { contextId: 'world' },
                targets: { mode: 'broadcast', scope: 'world' }
            });
            expect(lifecycle.state).toBe('queued');
            expect(lifecycle.evidence.carrierFallback).toBeUndefined();
        }
    );

    it('admits a world send on rtc over RTC alone and ends the handle rejected by the injected unsupported refusal', async () => {
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementationOnce(async (message) => toAdmission(message, UNSUPPORTED_VERDICT));

        const handle = await createRoomChannel(createRallarTestFacade(), WORLD_TOPIC_ID).send({ text: 'world' }, { strategy: 'rtc', scope: 'world' });
        const { lifecycle } = await handle.wait();

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0]![0].targets).toEqual({ mode: 'broadcast', scope: 'world' });
        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0]![1]).toBe('hold');
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        expect(lifecycle).toMatchObject({ state: 'rejected', evidence: { failure: { kind: 'refused', reason: 'unsupported' } } });
    });

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'refuses a world send on a room topic on %s before either carrier admits it',
        async (strategy) => {
            await expect(createRoomChannel().send({ text: 'world' }, { strategy, scope: 'world' }))
                .rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.topicId', code: 'world-on-room-topic' })] });
            expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        }
    );

    it('defaults a WS send that names neither a room nor a scope to the sender\'s world', async () => {
        setRallarFacadeRoomSnapshots([]);

        await createRallarTestFacade().messages.ws.send({ topicId: 'app.chat', typeId: 'chat.message.v1', payload: { text: 'hi' } });

        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0]![0]).toMatchObject({
            route: { contextId: 'world' },
            targets: { mode: 'broadcast', scope: 'world' }
        });
    });
});

describe('a principal or listed room send', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRallarFacadeTestRuntime();
        rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
        webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);
        setRallarFacadeRoomSnapshots([createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: ['session-1', 'peer-1'] })]);
    });

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'addresses the principal in its room as a principal broadcast on %s',
        async (strategy) => {
            await createRoomChannel().send({ text: 'mine' }, { strategy, scope: 'principal', principalId: 'principal-1' });

            const [first] = [...rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls, ...webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls];
            expect(first![0].targets).toMatchObject({
                mode: 'broadcast',
                scope: 'principal',
                groupRef: ROOM_REF,
                principalRef: PRINCIPAL_REF
            });
            expect(first![0].delivery).toMatchObject({ ack: 'all-logical-recipients' });
        }
    );

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'addresses a fixed list in its room as a listed room broadcast on %s',
        async (strategy) => {
            await createRoomChannel().send({ text: 'listed' }, { strategy, recipientPeerIds: ['peer-1'] });

            const [first] = [...rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls, ...webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls];
            expect(first![0].targets).toMatchObject({
                mode: 'broadcast',
                scope: 'room',
                groupRef: ROOM_REF,
                recipientPeerIds: ['peer-1']
            });
        }
    );

    it('a typed rtc send excludes its exceptPeerIds as a room broadcast', async () => {
        await createRoomChannel().send({ text: 'others' }, { strategy: 'rtc', exceptPeerIds: ['peer-1'] });

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0]![0].targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: ROOM_REF,
            exceptPeerIds: ['peer-1']
        });
    });

    it('resolves the default room for a principal send on ws, as for a room send', async () => {
        const facade = createRallarTestFacade();
        facade.setDefaults({ applicationId: 'app-1', room: { roomRef: ROOM_REF } });

        await facade.messages.ws.send({
            scope: 'principal',
            principalId: 'principal-1',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            payload: { text: 'mine' }
        });

        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0]![0].targets).toMatchObject({
            mode: 'broadcast',
            scope: 'principal',
            groupRef: ROOM_REF,
            principalRef: PRINCIPAL_REF
        });
    });

    it('hands the principal broadcast to WS as it came when the RTC leg cannot freeze it', async () => {
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementationOnce(async (message) =>
            toAdmission(message, { kind: 'unroutable', reason: 'no-route', detail: 'no room authority' })
        );

        const handle = await createRoomChannel().send({ text: 'mine' }, { scope: 'principal', principalId: 'principal-1' });
        await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });

        const [rtcMessage] = rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0]!;
        const [wsMessage] = webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0]!;
        expect(wsMessage.id.msgId).toBe(rtcMessage.id.msgId);
        expect(wsMessage.targets).toEqual(rtcMessage.targets);
    });
});

describe('the audience inputs of a send', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRallarFacadeTestRuntime();
        rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
        webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);
    });

    it('returns every audience issue together before connecting', async () => {
        const facade = createRallarTestFacade();

        await expect(facade.messages.ws.send({
            scope: 'principal',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            payload: {},
            recipientPeerIds: []
        })).rejects.toMatchObject({
            issues: [
                expect.objectContaining({ path: '$.roomId', code: 'missing-room' }),
                expect.objectContaining({ path: '$.roomRef', code: 'missing-room-ref' }),
                expect.objectContaining({ path: '$.principalId', code: 'missing-principal-id' }),
                expect.objectContaining({ path: '$.recipientPeerIds', code: 'fixed-audience-requires-room-scope' }),
                expect.objectContaining({ path: '$.recipientPeerIds', code: 'invalid-fixed-audience' })
            ]
        });
        expect(facade.isConnected()).toBe(false);
    });

    it('requires the principal scope beside a principal id', async () => {
        await expect(
            createRallarTestFacade().messages.ws.send({
                roomRef: ROOM_REF,
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
                payload: {},
                principalId: 'principal-1'
            })
        ).rejects.toMatchObject({
            issues: [expect.objectContaining({ path: '$.principalId', code: 'principal-scope-required' })]
        });
    });

    it.each([
        { label: 'a repeated session', recipientPeerIds: ['peer-1', 'peer-1'] },
        { label: 'more than 256 sessions', recipientPeerIds: Array.from({ length: 257 }, (_, index) => `peer-${index}`) }
    ])('refuses a fixed list with $label', async ({ recipientPeerIds }) => {
        await expect(
            createRallarTestFacade().messages.ws.send({
                roomRef: ROOM_REF,
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
                payload: {},
                recipientPeerIds
            })
        ).rejects.toMatchObject({
            issues: [expect.objectContaining({ path: '$.recipientPeerIds', code: 'invalid-fixed-audience' })]
        });
    });

    it('names the three scopes a browser WS send may take', async () => {
        await expect(
            createRallarTestFacade().messages.ws.send({
                scope: JSON.parse('"all"'),
                topicId: 'app.chat',
                typeId: 'chat.message.v1',
                payload: {}
            })
        ).rejects.toMatchObject({
            issues: [expect.objectContaining({ code: 'invalid-scope', message: 'WS scope must be room, world, or principal.' })]
        });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
    });

    it('an rtc-strategy send with an invalid scope produces no RTC admission', async () => {
        setRallarFacadeRoomSnapshots([createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: ['session-1', 'peer-1'] })]);

        await expect(createRoomChannel().send({ text: 'all' }, { strategy: 'rtc', scope: JSON.parse('"all"') }))
            .rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.scope', code: 'invalid-scope' })] });
        expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
    });

    it.each<RallarTypedMessageSendStrategy>(['rtc-with-ws-fallback', 'ws-then-rtc'])(
        'a %s send with an invalid scope produces no admission on either carrier and stays disconnected',
        async (strategy) => {
            setRallarFacadeRoomSnapshots([createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: ['session-1', 'peer-1'] })]);
            const facade = createRallarTestFacade();

            await expect(createRoomChannel(facade).send({ text: 'all' }, { strategy, scope: JSON.parse('"all"') }))
                .rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.scope', code: 'invalid-scope' })] });
            expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(facade.isConnected()).toBe(false);
        }
    );

    it('refuses an rtc send whose exceptPeerIds names an invalid session id', async () => {
        setRallarFacadeRoomSnapshots([createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: ['session-1', 'peer-1'] })]);

        await expect(createRoomChannel().send({ text: 'others' }, { strategy: 'rtc', exceptPeerIds: ['bad peer'] }))
            .rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.exceptPeerIds[0]' })] });
    });
});

function createRoomChannel(facade = createRallarTestFacade(), topicId = 'room.chat') {
    return facade.messages.room<{ text: string; }>({
        topicId,
        typeId: 'chat.message.v1',
        roomRef: ROOM_REF,
        purpose: 'notification'
    });
}

function toAdmission(message: ALMessage, verdict: ALDeliveryAdmissionVerdict): ALOutboundEnqueueResult {
    return { verdict, message, entries: [], reason: verdict.kind, trackedReceiptAlgo: 'none' };
}
