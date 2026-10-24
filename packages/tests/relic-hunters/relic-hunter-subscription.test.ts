import {
    createRelicGame,
    isRelicHunterEvent,
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicCommand,
    type RelicHunterEvent
} from '@relic-hunters/mod.ts';
import type {
    RallarMessage,
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel,
    RallarTypedPayloadHandler
} from '@shared-web/browser/rallar.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { subscribeRelicHunterEvents } from '../../../apps/relic-hunters-v1/src/game/subscribe-relic-hunter-events.ts';
import { createAppInboxTestResilience } from '../shared-server/rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { connectGameSession } from './relic-game-database-fixture.ts';
import { createInboxFixture } from './relic-game-inbox-fixture.ts';

type RelicHunterEventFacade = Parameters<typeof subscribeRelicHunterEvents>[0];

describe('committed Relic private browser notifications', () => {
    it('accepts committed private rule refusals and action receipts through the real browser guard', async () => {
        const fixture = await createInboxFixture();
        const double = createFacadeDouble();
        const events: RelicHunterEvent[] = [];
        const owner = fixture.owner;
        subscribeRelicHunterEvents(double.facade, fixture.ref.groupId, {
            principalId: owner.clientId,
            playerId: owner.sessionId,
            onEvent: (event) => events.push(event)
        });
        try {
            await connectGameSession(fixture, owner);
            const base = { protocolVersion: RELIC_PROTOCOL_VERSION, gameId: fixture.ref.groupId, username: owner.username };
            const commands: readonly RelicCommand[] = [
                { ...base, kind: 'join-expedition' },
                { ...base, kind: 'submit-action', action: { kind: 'search' } },
                { ...base, kind: 'start-expedition' },
                { ...base, kind: 'submit-action', action: { kind: 'search' } }
            ];
            for (const [index, move] of commands.entries()) {
                fixture.nowEpochMs += 1;
                const queued = await fixture.inbox.enqueue({
                    ...fixture.command,
                    operation: 'command',
                    move,
                    requestId: `browser-guard-${index}`
                }, async () => createRelicGame(fixture.ref.groupId, fixture.ref.groupId, fixture.nowEpochMs));
                await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                expect((await fixture.inbox.wait(queued)).status).toBe(index === 1 ? 'refused' : 'applied');
            }
            const rows = await fixture.storage.sql<{ ri_resource: string; }[]>`
                select ri_resource from resource_inbox where ri_type_id = 'WS_OUTBOX'`;
            const messages = rows.map((row) => decodePersistedALMessage(row.ri_resource))
                .filter((message) => message.payload.typeId === RELIC_TYPES.hunter)
                .sort((left, right) => left.id.ts - right.id.ts);
            expect(messages).toHaveLength(2);
            for (const raw of messages) {
                const payload = JSON.parse(raw.payload.resource);
                if (!isRelicHunterEvent(payload)) {
                    throw new Error('Committed hunter event must match the browser payload contract');
                }
                await double.deliver(payload, toMessage(payload, raw, fixture.ref.groupId));
            }
            expect(events.map((event) => event.kind)).toEqual(['command-refused', 'action-recorded']);
            expect(events.every((event) => event.playerId === owner.sessionId)).toBe(true);
        }
        finally {
            await fixture.storage.close();
        }
    }, 30_000);
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
        messages: { rtc: unusedLane, ws: unusedLane, channel: unusedByTheChannel, room, readUsage: unusedByTheChannel }
    };
    const deliver = async (payload: RelicHunterEvent, message: RallarMessage<RelicHunterEvent>) => {
        for (const handler of handlers) {
            await handler(payload, message);
        }
    };
    return { facade, roomDefinitions, deliver, subscribed: () => handlers.length > 0 };
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
