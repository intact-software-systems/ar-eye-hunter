import { describe, expect, it } from 'vitest';

import { TOWN_MATCH_BUILD, TOWN_MATCH_PROTOCOL, type TownMatchFrame } from '../../../apps/cca-2d/src/match/match-protocol.ts';
import { TownMatchTransport } from '../../../apps/cca-2d/src/match/match-transport.ts';
import type { RallarTypedWsSendOptions } from '../../shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRoomRealtimeSendResult } from '../../shared-web/browser/rallar-realtime-facade.ts';

const frame: TownMatchFrame = {
    protocol: TOWN_MATCH_PROTOCOL,
    build: TOWN_MATCH_BUILD,
    roomRef: { applicationId: 'cca-2d', workspaceId: 'default', groupId: 'town' },
    epoch: 1,
    matchId: 'round',
    sequence: 5,
    action: { kind: 'controls', x: 1, z: 0, dash: 1 }
};
const sent: RallarRoomRealtimeSendResult = {
    transport: 'rtc',
    status: 'sent',
    laneId: 'realtime',
    peerIds: ['bob'],
    desiredPeerIds: ['bob'],
    results: [{ peerId: 'bob', laneId: 'realtime', result: { status: 'sent', bufferedAmount: 0 } }]
};

interface WsAttempt {
    readonly wire: string;
    readonly options: RallarTypedWsSendOptions<string> | undefined;
}

function createUnavailableWs(attempts: WsAttempt[]): TownMatchTransport.Dependencies['reliable'] {
    return {
        onWs: () => () => {},
        async sendWs(wire, options) {
            attempts.push({ wire, options });
            throw new Error('WS unavailable');
        }
    };
}

describe('RTC-first game transport with scoped WS fallback', () => {
    it('does not relay live frames over WS when RTC accepts every intended peer', async () => {
        const attempts: WsAttempt[] = [];
        const transport = new TownMatchTransport({
            reliable: createUnavailableWs(attempts),
            realtime: { on: () => () => {}, send: async () => sent }
        });
        await transport.write(frame, ['bob']);
        expect(transport.getLiveSend()).toBe('rtc');
        expect(attempts).toEqual([]);
        transport.stop();
    });

    it('falls back only for the missing peer and preserves frame identity, surfacing WS failure', async () => {
        const attempts: WsAttempt[] = [];
        const transport = new TownMatchTransport({
            reliable: createUnavailableWs(attempts),
            realtime: { on: () => () => {}, send: async () => ({ ...sent, status: 'partial', desiredPeerIds: ['bob', 'carol'] }) }
        });
        await expect(transport.write(frame, ['bob', 'carol'])).rejects.toThrow('WS unavailable');
        expect(attempts).toEqual([{
            wire: JSON.stringify(frame),
            options: {
                recipientPeerIds: ['carol'],
                ttlMs: 250,
                reliability: 'best-effort',
                ack: 'none'
            }
        }]);
        expect(transport.getLiveSend()).toBe('mixed');
        transport.stop();
    });

    it('uses WS when RTC throws and keeps checkpoint agreement on WS even when RTC is ready', async () => {
        const attempts: WsAttempt[] = [];
        const transport = new TownMatchTransport({
            reliable: createUnavailableWs(attempts),
            realtime: {
                on: () => () => {},
                send: async () => {
                    throw new Error('RTC closed');
                }
            }
        });
        await expect(transport.write(frame, ['bob'])).rejects.toThrow('WS unavailable');
        expect(JSON.parse(attempts[0].wire)).toEqual(frame);
        expect(transport.getLiveSend()).toBe('ws');
        const checkpoint: TownMatchFrame = { ...frame, action: { kind: 'commit', digest: 'a'.repeat(64), proposalSequence: 4 } };
        const readyTransport = new TownMatchTransport({
            reliable: createUnavailableWs(attempts),
            realtime: { on: () => () => {}, send: async () => sent }
        });
        await expect(readyTransport.write(checkpoint, ['bob'])).rejects.toThrow('WS unavailable');
        expect(attempts[1].options?.ttlMs).toBe(2000);
        expect(JSON.parse(attempts[1].wire)).toEqual(checkpoint);
        transport.stop();
        readyTransport.stop();
    });

    it('cannot start a fallback after the owning match stops during an RTC send', async () => {
        const attempts: WsAttempt[] = [];
        const pending = Promise.withResolvers<RallarRoomRealtimeSendResult>();
        const transport = new TownMatchTransport({
            reliable: createUnavailableWs(attempts),
            realtime: { on: () => () => {}, send: async () => await pending.promise }
        });
        const write = transport.write(frame, ['bob', 'carol']);
        transport.stop();
        pending.resolve(sent);
        await write;
        expect(attempts).toEqual([]);
    });
});
