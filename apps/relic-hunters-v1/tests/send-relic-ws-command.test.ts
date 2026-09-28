import {
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicCommand
} from '@ar-eye-hunter/relic-hunters/mod.ts';
import type {
    RallarMessageDeliveryOutcome,
    RallarMessageHandle,
    RallarRoomMessageChannelDefinition,
    RallarTypedMessageChannel
} from '@ar-eye-hunter/shared-web/browser/rallar.ts';
import { describe, expect, it, vi } from 'vitest';
import {
    RELIC_COMMAND_RECEIPT_WAIT_MS,
    sendRelicWsCommand
} from '../src/game/send-relic-ws-command.ts';

const COMMAND: RelicCommand = {
    protocolVersion: RELIC_PROTOCOL_VERSION,
    kind: 'start-expedition',
    gameId: 'room-42',
    username: 'Alice'
};

type RelicCommandFacade = Parameters<typeof sendRelicWsCommand>[0];

const ACKNOWLEDGED = {
    status: 'settled',
    lifecycle: { state: 'acknowledged', evidence: { reason: undefined } }
} as RallarMessageDeliveryOutcome;

describe('a Relic command to the server (D57 as applied, D72)', () => {
    it('sends on the command channel to the server peer and reports the end of its receipt', async () => {
        const { facade, roomDefinitions, sendWs, wait } = createFacadeDouble('default-qbox-server');

        const delivery = await sendRelicWsCommand(facade, 'room-42', COMMAND);

        expect(roomDefinitions).toEqual([{
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            purpose: 'command',
            roomId: 'room-42'
        }]);
        expect(sendWs).toHaveBeenCalledWith(COMMAND, { peerId: 'default-qbox-server' });
        expect(wait).toHaveBeenCalledWith({ timeoutMs: RELIC_COMMAND_RECEIPT_WAIT_MS });
        expect(delivery).toEqual({ state: 'acknowledged', reason: undefined });
    });

    it('sends nothing before the server id is known, so the runtime falls back to REST (C13)', async () => {
        const { facade, roomDefinitions } = createFacadeDouble(undefined);

        expect(await sendRelicWsCommand(facade, 'room-42', COMMAND)).toBeUndefined();
        expect(roomDefinitions).toEqual([]);
    });
});

function createFacadeDouble(serverPeerId: string | undefined) {
    const wait = vi.fn(async () => ACKNOWLEDGED);
    const handle: Partial<RallarMessageHandle> = { wait };
    const sendWs = vi.fn(async () => handle as RallarMessageHandle);
    const roomDefinitions: RallarRoomMessageChannelDefinition[] = [];
    function room<T>(definition: RallarRoomMessageChannelDefinition): RallarTypedMessageChannel<T> {
        roomDefinitions.push(definition);
        const channel: Partial<RallarTypedMessageChannel<T>> = { sendWs };
        return channel as RallarTypedMessageChannel<T>;
    }
    const messages: Partial<RelicCommandFacade['messages']> = { room };
    const facade: RelicCommandFacade = {
        serverPeerId: () => serverPeerId,
        messages: messages as RelicCommandFacade['messages']
    };
    return { facade, roomDefinitions, sendWs, wait };
}
