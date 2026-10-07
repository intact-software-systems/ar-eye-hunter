import {
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicHunterEvent
} from '@relic-hunters/mod.ts';
import type {
    RallarMessage,
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel,
    RallarTypedPayloadHandler
} from '@shared-web/browser/rallar.ts';
import { newALBroadcastMessage, newALPrincipalBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { describe, expect, it } from 'vitest';
import { subscribeRelicHunterEvents } from '../src/game/subscribe-relic-hunter-events.ts';

const ROOM_REF = {
    applicationId: DEFAULT_STATE_APPLICATION_ID,
    workspaceId: DEFAULT_STATE_WORKSPACE_ID,
    groupId: 'room-1'
};

const RECORDED: RelicHunterEvent = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    gameId: 'room-1',
    principalId: 'client-1',
    kind: 'action-recorded',
    round: 2,
    action: { kind: 'move', targetRoomId: 'hall' }
};

const REFUSED: RelicHunterEvent = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    gameId: 'room-1',
    principalId: 'client-1',
    kind: 'command-refused',
    command: 'force-resolve-round',
    text: 'Round timer has not expired.'
};

type RelicHunterEventFacade = Parameters<typeof subscribeRelicHunterEvents>[0];

describe('the Relic hunter channel', () => {
    it('subscribes the room\'s notification channel on the hunter topic, with no recovery owner', () => {
        const double = createFacadeDouble();

        const unsubscribe = subscribeRelicHunterEvents(double.facade, 'room-1', {
            principalId: 'client-1',
            onEvent: () => undefined
        });

        expect(double.roomDefinitions).toEqual([{
            topicId: RELIC_TOPICS.hunter,
            typeId: RELIC_TYPES.hunter,
            roomRef: ROOM_REF,
            purpose: 'notification'
        }]);
        expect(double.subscribed()).toBe(true);
        unsubscribe();
        expect(double.subscribed()).toBe(false);
    });

    it('hands on both kinds of event the server addressed to the hunter\'s principal in the room', async () => {
        const double = createFacadeDouble();
        const events: RelicHunterEvent[] = [];
        subscribeRelicHunterEvents(double.facade, 'room-1', { principalId: 'client-1', onEvent: (event) => events.push(event) });

        await double.deliver(RECORDED, toPrincipalMessage(RECORDED, 'room-1'));
        await double.deliver(REFUSED, toPrincipalMessage(REFUSED, 'room-1'));

        expect(events).toEqual([RECORDED, REFUSED]);
    });

    it('drops an event of another room, another game or another principal, a room broadcast and a malformed payload', async () => {
        const double = createFacadeDouble();
        const events: RelicHunterEvent[] = [];
        subscribeRelicHunterEvents(double.facade, 'room-1', { principalId: 'client-1', onEvent: (event) => events.push(event) });
        const otherGame = { ...RECORDED, gameId: 'room-2' };
        const otherPrincipal = { ...RECORDED, principalId: 'client-2' };
        const malformed: RelicHunterEvent = JSON.parse(JSON.stringify({ ...REFUSED, command: 'cheat' }));

        await double.deliver(RECORDED, toPrincipalMessage(RECORDED, 'room-2'));
        await double.deliver(otherGame, toPrincipalMessage(otherGame, 'room-1'));
        await double.deliver(otherPrincipal, toPrincipalMessage(otherPrincipal, 'room-1'));
        await double.deliver(RECORDED, toRoomMessage(RECORDED));
        await double.deliver(malformed, toPrincipalMessage(malformed, 'room-1'));

        expect(events).toEqual([]);
    });
});

function createFacadeDouble() {
    const roomDefinitions: RallarRoomMessageChannelDefinition[] = [];
    const handlers: RallarTypedPayloadHandler<RelicHunterEvent>[] = [];
    function room<T>(definition: RallarRoomMessageChannelDefinition): RallarTypedMessageChannel<T> {
        roomDefinitions.push(definition);
        const onWs = (handler: RallarTypedPayloadHandler<T>) => {
            handlers.push(handler as RallarTypedPayloadHandler<RelicHunterEvent>);
            return () => {
                handlers.splice(0);
            };
        };
        return { send: unusedByTheChannel, sendRtc: unusedByTheChannel, sendWs: unusedByTheChannel, onRtc: unusedByTheChannel, onWs };
    }
    const unusedLane = { send: unusedByTheChannel, onMessage: unusedByTheChannel };
    const facade: RelicHunterEventFacade = {
        messages: { rtc: unusedLane, ws: unusedLane, channel: unusedByTheChannel, room }
    };
    const deliver = async (payload: RelicHunterEvent, message: RallarMessage<RelicHunterEvent>) => {
        for (const handler of handlers) {
            await handler(payload, message);
        }
    };
    return { facade, roomDefinitions, deliver, subscribed: () => handlers.length > 0 };
}

function toPrincipalMessage(event: RelicHunterEvent, roomId: string): RallarMessage<RelicHunterEvent> {
    const groupRef = { ...ROOM_REF, groupId: roomId };
    const raw = newALPrincipalBroadcastMessage(
        'default-qbox-server',
        newALRoute(RELIC_TOPICS.hunter, roomId, `${event.gameId}:${event.principalId}`),
        {
            groupRef,
            principalRef: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId, principalId: event.principalId }
        },
        RELIC_TYPES.hunter,
        event
    );
    return toMessage(event, raw, roomId);
}

function toRoomMessage(event: RelicHunterEvent): RallarMessage<RelicHunterEvent> {
    const raw = newALBroadcastMessage(
        'default-qbox-server',
        newALRoute(RELIC_TOPICS.hunter, 'room-1', `${event.gameId}:${event.principalId}`),
        'room',
        RELIC_TYPES.hunter,
        event,
        { groupRef: ROOM_REF }
    );
    return toMessage(event, raw, 'room-1');
}

function toMessage(
    event: RelicHunterEvent,
    raw: RallarMessage<RelicHunterEvent>['raw'],
    roomId: string
): RallarMessage<RelicHunterEvent> {
    return {
        transport: 'ws',
        typeId: RELIC_TYPES.hunter,
        topicId: RELIC_TOPICS.hunter,
        contextId: roomId,
        resourceId: raw.route.resourceId,
        roomId,
        senderId: 'default-qbox-server',
        payload: event,
        raw,
        receivedAtEpochMs: 0
    };
}

function unusedByTheChannel(): never {
    throw new Error('The hunter channel only receives over WS.');
}
