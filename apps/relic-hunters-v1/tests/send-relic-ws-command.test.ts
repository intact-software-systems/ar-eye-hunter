import {
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicCommand
} from '@ar-eye-hunter/relic-hunters/mod.ts';
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

describe('a Relic command to the server (D57 as applied, D72)', () => {
    it('sends on the command channel to the server peer and reports the end of its receipt', async () => {
        const wait = vi.fn(async () => ({
            status: 'settled',
            lifecycle: { state: 'acknowledged', evidence: { reason: undefined } }
        }));
        const sendWs = vi.fn(async () => ({ wait }));
        const room = vi.fn(() => ({ sendWs }));
        const facade = {
            serverPeerId: () => 'default-qbox-server',
            messages: { room }
        } as unknown as RelicCommandFacade;

        const delivery = await sendRelicWsCommand(facade, 'room-42', COMMAND);

        expect(room).toHaveBeenCalledWith({
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            purpose: 'command',
            roomId: 'room-42'
        });
        expect(sendWs).toHaveBeenCalledWith(COMMAND, { peerId: 'default-qbox-server' });
        expect(wait).toHaveBeenCalledWith({ timeoutMs: RELIC_COMMAND_RECEIPT_WAIT_MS });
        expect(delivery).toEqual({ state: 'acknowledged', reason: undefined });
    });

    it('sends nothing before the server id is known, so the runtime falls back to REST (C13)', async () => {
        const room = vi.fn();
        const facade = {
            serverPeerId: () => undefined,
            messages: { room }
        } as unknown as RelicCommandFacade;

        expect(await sendRelicWsCommand(facade, 'room-42', COMMAND)).toBeUndefined();
        expect(room).not.toHaveBeenCalled();
    });
});
