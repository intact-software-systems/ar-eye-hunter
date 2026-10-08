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

const EXCLUSIVE_UNSUPPORTED_VERDICT: ALDeliveryAdmissionVerdict = {
    kind: 'refused',
    reason: 'unsupported',
    detail: 'RTC cannot arbitrate an exclusive claim: an exclusive send is unsupported'
};

const ROOMLESS_EXCLUSIVE_ISSUE = {
    path: '$.ownership',
    code: 'exclusive-requires-room-audience',
    message: 'An exclusive send claims a resource in its room: it names a room.'
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

describe('a group-leader send', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRallarFacadeTestRuntime();
        rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
        webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);
        setRallarFacadeRoomSnapshots([createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: ['session-1', 'peer-1'] })]);
    });

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'passes a group-leader room send through to its carrier with the ack unchanged on %s',
        async (strategy) => {
            await createRoomChannel().send({ text: 'lead' }, { strategy, ack: 'group-leader' });

            const [first] = [...rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls, ...webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls];
            expect(first![0].targets).toMatchObject({ groupRef: ROOM_REF });
            expect(first![0].targets?.mode).not.toBe('unicast');
            expect(first![0].delivery).toMatchObject({ ack: 'group-leader' });
        }
    );

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'refuses a group-leader world send on %s before either carrier admits it',
        async (strategy) => {
            await expect(
                createRoomChannel(createRallarTestFacade(), WORLD_TOPIC_ID).send({ text: 'lead' }, { strategy, scope: 'world', ack: 'group-leader' })
            ).rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.ack', code: 'leader-requires-room-audience' })] });
            expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        }
    );

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc', 'rtc-with-ws-fallback'])(
        'refuses a group-leader send addressed to one peer on %s before either carrier admits it',
        async (strategy) => {
            await expect(createRoomChannel().send({ text: 'lead' }, { strategy, peerId: 'peer-1', ack: 'group-leader' }))
                .rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.ack', code: 'leader-requires-room-audience' })] });
            expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        }
    );
});

describe('an exclusive send', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetRallarFacadeTestRuntime();
        rtcRxStreamer = vi.mocked(mocks.apiMiddleware.middleware.rtcRxStreamer);
        webSocketQueueBox = vi.mocked(mocks.apiMiddleware.middleware.webSocketQueueBox);
        setRallarFacadeRoomSnapshots([createGroupSnapshotFixture({ ...ROOM_REF, sessionIds: ['session-1', 'peer-1'] })]);
    });

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'claims its resource over WS alone on %s, with no RTC leg and no fallback evidence',
        async (strategy) => {
            const handle = await createRoomChannel().send(
                { text: 'mine' },
                { strategy, ownership: 'exclusive', resourceId: 'pickup-1' }
            );

            const { lifecycle } = await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });

            expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0]![0]).toMatchObject({
                route: { resourceId: 'pickup-1', contextId: ROOM_REF.groupId },
                targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM_REF },
                delivery: { ownership: 'exclusive' }
            });
            expect(lifecycle.evidence.carrierFallback).toBeUndefined();
        }
    );

    it.each<RallarTypedMessageSendStrategy>(['rtc-with-ws-fallback', 'ws-then-rtc'])(
        'claims its resource over WS alone on %s when only its qos asks for exclusive ownership',
        async (strategy) => {
            await createRoomChannel().send(
                { text: 'mine' },
                { strategy, qos: { ownership: { algo: 'exclusive' } }, resourceId: 'pickup-1' }
            );

            expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls).toEqual([]);
            expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0]![0]).toMatchObject({
                route: { resourceId: 'pickup-1' },
                qos: { ownership: { algo: 'exclusive' } }
            });
        }
    );

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'claims its resource for a send addressed to one peer over WS alone on %s',
        async (strategy) => {
            await createRoomChannel().send(
                { text: 'mine' },
                { strategy, peerId: 'peer-1', ownership: 'exclusive', resourceId: 'pickup-1' }
            );

            expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0]![0]).toMatchObject({
                route: { resourceId: 'pickup-1' },
                targets: { mode: 'unicast', toPeerId: 'peer-1', groupRef: ROOM_REF },
                delivery: { ownership: 'exclusive' }
            });
        }
    );

    it.each([
        { audience: 'the room', options: {} },
        { audience: 'one peer', options: { peerId: 'peer-1' } }
    ])('admits an exclusive send to $audience on rtc over RTC alone and ends the handle rejected by the injected unsupported refusal', async ({ options }) => {
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementationOnce(async (message) => toAdmission(message, EXCLUSIVE_UNSUPPORTED_VERDICT));

        const handle = await createRoomChannel().send(
            { text: 'mine' },
            { strategy: 'rtc', ownership: 'exclusive', resourceId: 'pickup-1', ...options }
        );
        const { lifecycle } = await handle.wait();

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0]![0].delivery).toMatchObject({ ownership: 'exclusive' });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        expect(lifecycle).toMatchObject({
            state: 'rejected',
            evidence: { attempts: [], carrierFallback: undefined, failure: { kind: 'refused', reason: 'unsupported' } }
        });
    });

    it.each(
        [
            { send: 'a shared send that names a resource', options: { resourceId: 'pickup-1' } },
            {
                send: 'an exclusive send its qos makes shared, naming no resource',
                options: { ownership: 'exclusive', qos: { ownership: { algo: 'shared' } } }
            }
        ] as const
    )('keeps $send on its RTC-first route', async ({ options }) => {
        await createRoomChannel().send({ text: 'ours' }, { strategy: 'rtc-with-ws-fallback', ...options });

        expect(rtcRxStreamer.enqueueOutboxIfAbsent).toHaveBeenCalledTimes(1);
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
    });

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'refuses an exclusive send that names no resource on %s before either carrier admits it',
        async (strategy) => {
            await expect(createRoomChannel().send({ text: 'mine' }, { strategy, ownership: 'exclusive' }))
                .rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.ownership', code: 'exclusive-requires-resource' })] });
            await expect(createRoomChannel().send({ text: 'mine' }, { strategy, qos: { ownership: { algo: 'exclusive' } } }))
                .rejects.toMatchObject({ issues: [expect.objectContaining({ path: '$.ownership', code: 'exclusive-requires-resource' })] });
            expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        }
    );

    it.each<RallarTypedMessageSendStrategy>(['ws', 'rtc', 'rtc-with-ws-fallback', 'ws-then-rtc'])(
        'refuses an exclusive world send on %s before either carrier admits it',
        async (strategy) => {
            await expect(
                createRoomChannel(createRallarTestFacade(), WORLD_TOPIC_ID).send(
                    { text: 'mine' },
                    { strategy, scope: 'world', ownership: 'exclusive', resourceId: 'pickup-1' }
                )
            ).rejects.toMatchObject({ issues: [ROOMLESS_EXCLUSIVE_ISSUE] });
            expect(rtcRxStreamer.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
            expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
        }
    );

    it('refuses an exclusive WS send to one peer that names no room, saying it names a room', async () => {
        await expect(
            createRallarTestFacade().messages.ws.send({
                topicId: 'app.chat',
                typeId: 'chat.message.v1',
                payload: { text: 'mine' },
                peerId: 'peer-1',
                ownership: 'exclusive',
                resourceId: 'pickup-1'
            })
        ).rejects.toMatchObject({ issues: [ROOMLESS_EXCLUSIVE_ISSUE] });
        expect(webSocketQueueBox.enqueueOutboxIfAbsent).not.toHaveBeenCalled();
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
