import {
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicRoundTransitionEvent
} from '@relic-hunters/mod.ts';
import type {
    RallarMessage,
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel,
    RallarTypedPayloadHandler
} from '@shared-web/browser/rallar.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import type { ALInboundResyncCursor } from '@shared/alm/inbound/al-inbound-resync-required.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { describe, expect, it } from 'vitest';
import { subscribeRelicRoundTransitions } from '../src/game/subscribe-relic-round-transitions.ts';

const ROOM_REF = {
    applicationId: DEFAULT_STATE_APPLICATION_ID,
    workspaceId: DEFAULT_STATE_WORKSPACE_ID,
    groupId: 'room-1'
};

const ROUND_STARTED: RelicRoundTransitionEvent = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    gameId: 'room-1',
    round: 1,
    phase: 'planning',
    transition: 'round-started',
    text: 'Alice started the expedition.'
};

type RelicRoundTransitionFacade = Parameters<typeof subscribeRelicRoundTransitions>[0];

describe('the Relic round-transition channel', () => {
    it('subscribes the room\'s notification channel with a recovery owner for every incarnation of the room\'s game', () => {
        const double = createFacadeDouble();
        let resyncs = 0;

        const unsubscribe = subscribeRelicRoundTransitions(double.facade, 'room-1', {
            onTransition: () => undefined,
            onResyncRequired: () => {
                resyncs += 1;
            }
        });

        expect(double.roomDefinitions).toEqual([{
            topicId: RELIC_TOPICS.event,
            typeId: RELIC_TYPES.event,
            roomRef: ROOM_REF,
            purpose: 'notification',
            recovery: { onResyncRequired: expect.any(Function) }
        }]);
        double.roomDefinitions[0].recovery?.onResyncRequired(toResyncCursor('room-2:1000'));
        double.roomDefinitions[0].recovery?.onResyncRequired(toResyncCursor('room-10:1000'));
        expect(resyncs).toBe(0);
        double.roomDefinitions[0].recovery?.onResyncRequired(toResyncCursor('room-1:900'));
        double.roomDefinitions[0].recovery?.onResyncRequired(toResyncCursor('room-1:1000'));
        expect(resyncs).toBe(2);
        expect(double.subscribed()).toBe(true);
        unsubscribe();
        expect(double.subscribed()).toBe(false);
    });

    it('hands on a round transition the server published to the room', async () => {
        const double = createFacadeDouble();
        const transitions: RelicRoundTransitionEvent[] = [];
        subscribeRelicRoundTransitions(double.facade, 'room-1', {
            onTransition: (event) => transitions.push(event),
            onResyncRequired: () => undefined
        });

        await double.deliver(ROUND_STARTED, toRoomMessage(ROUND_STARTED, 'room-1'));

        expect(transitions).toEqual([ROUND_STARTED]);
    });

    it('drops a transition of another room, one whose game is not the room\'s, and a payload that is not a transition', async () => {
        const double = createFacadeDouble();
        const transitions: RelicRoundTransitionEvent[] = [];
        subscribeRelicRoundTransitions(double.facade, 'room-1', {
            onTransition: (event) => transitions.push(event),
            onResyncRequired: () => undefined
        });
        const otherGame = { ...ROUND_STARTED, gameId: 'room-2' };
        const malformed: RelicRoundTransitionEvent = JSON.parse(JSON.stringify({ ...ROUND_STARTED, transition: 'round-paused' }));

        await double.deliver(ROUND_STARTED, toRoomMessage(ROUND_STARTED, 'room-2'));
        await double.deliver(otherGame, toRoomMessage(otherGame, 'room-1'));
        await double.deliver(malformed, toRoomMessage(malformed, 'room-1'));

        expect(transitions).toEqual([]);
    });
});

function createFacadeDouble() {
    const roomDefinitions: RallarRoomMessageChannelDefinition[] = [];
    const handlers: RallarTypedPayloadHandler<RelicRoundTransitionEvent>[] = [];
    function room<T>(definition: RallarRoomMessageChannelDefinition): RallarTypedMessageChannel<T> {
        roomDefinitions.push(definition);
        const onWs = (handler: RallarTypedPayloadHandler<T>) => {
            handlers.push(handler as RallarTypedPayloadHandler<RelicRoundTransitionEvent>);
            return () => {
                handlers.splice(0);
            };
        };
        return { send: unusedByTheChannel, sendRtc: unusedByTheChannel, sendWs: unusedByTheChannel, onRtc: unusedByTheChannel, onWs };
    }
    const unusedLane = { send: unusedByTheChannel, onMessage: unusedByTheChannel };
    const facade: RelicRoundTransitionFacade = {
        messages: { rtc: unusedLane, ws: unusedLane, channel: unusedByTheChannel, room }
    };
    const deliver = async (payload: RelicRoundTransitionEvent, message: RallarMessage<RelicRoundTransitionEvent>) => {
        for (const handler of handlers) {
            await handler(payload, message);
        }
    };
    return { facade, roomDefinitions, deliver, subscribed: () => handlers.length > 0 };
}

function toRoomMessage(event: RelicRoundTransitionEvent, roomId: string): RallarMessage<RelicRoundTransitionEvent> {
    const raw = newALBroadcastMessage(
        'default-qbox-server',
        newALRoute(RELIC_TOPICS.event, roomId, `${event.gameId}:${event.round}`),
        'room',
        RELIC_TYPES.event,
        event,
        { groupRef: { ...ROOM_REF, groupId: roomId } }
    );
    return {
        transport: 'ws',
        typeId: RELIC_TYPES.event,
        topicId: RELIC_TOPICS.event,
        contextId: roomId,
        resourceId: raw.route.resourceId,
        roomId,
        senderId: 'default-qbox-server',
        payload: event,
        raw,
        receivedAtEpochMs: 0
    };
}

function toResyncCursor(orderingKey: string): ALInboundResyncCursor {
    return {
        orderingKey,
        senderId: 'default-qbox-server',
        epoch: 2,
        lastContiguousSeq: 0,
        expectedSeq: 1,
        observedSeq: 300,
        carrier: 'ws'
    };
}

function unusedByTheChannel(): never {
    throw new Error('The round-transition channel only receives over WS.');
}
