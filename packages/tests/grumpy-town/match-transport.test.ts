import { describe, expect, it } from 'vitest';

import { createMessageDelivery } from '../shared-web/messages/test-message-delivery.ts';

import { TOWN_MATCH_BUILD, TOWN_MATCH_PROTOCOL, type TownMatchFrame } from '../../../apps/grumpy-town/src/match/match-protocol.ts';
import { TownMatchTransport } from '../../../apps/grumpy-town/src/match/realtime/town-match-transport.ts';
import type { RallarMessageHandle, RallarTypedWsSendOptions } from '@shared-web/browser/rallar-core.ts';
import type { RallarRoomRealtimeSendResult } from '@shared-web/browser/rallar-realtime.ts';

const frame: TownMatchFrame = {
    protocol: TOWN_MATCH_PROTOCOL,
    build: TOWN_MATCH_BUILD,
    roomRef: { applicationId: 'grumpy-town', workspaceId: 'default', groupId: 'town' },
    epoch: 1,
    matchId: 'round',
    sequence: 5,
    action: { kind: 'controls', x: 1, z: 0, dash: 1 }
};
const ack: TownMatchFrame = { ...frame, action: { kind: 'ack', digest: 'a'.repeat(64), proposalSequence: 4 } };
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

function unavailableWs(): never {
    throw new Error('WS unavailable');
}

function admittedWs(): RallarMessageHandle {
    return createMessageDelivery('ws', { kind: 'admitted', durable: false, queuedAttempts: 1 }).handle;
}

function recordWs(
    attempts: WsAttempt[],
    send: (attempt: number) => RallarMessageHandle
): TownMatchTransport.Dependencies['reliable'] {
    return {
        onWs: () => () => {},
        async sendWs(wire, options) {
            attempts.push({ wire, options });
            return send(attempts.length);
        }
    };
}

describe('RTC-first game transport with scoped WS fallback', () => {
    it('does not relay live frames over WS when RTC accepts every intended peer', async () => {
        const attempts: WsAttempt[] = [];
        const transport = new TownMatchTransport({
            timers: { nowMs: () => 0 },
            reliable: recordWs(attempts, unavailableWs),
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
            timers: { nowMs: () => 0 },
            reliable: recordWs(attempts, unavailableWs),
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
            timers: { nowMs: () => 0 },
            reliable: recordWs(attempts, unavailableWs),
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
            timers: { nowMs: () => 0 },
            reliable: recordWs(attempts, unavailableWs),
            realtime: { on: () => () => {}, send: async () => sent }
        });
        await expect(readyTransport.write(checkpoint, ['bob'])).rejects.toThrow('WS unavailable');
        expect(attempts[1].options?.ttlMs).toBe(2000);
        expect(JSON.parse(attempts[1].wire)).toEqual(checkpoint);
        transport.stop();
        readyTransport.stop();
    });

    it.each(['throw', 'rejected', 'failed'] as const)('retries the same agreement immediately after a %s send', async failure => {
        const attempts: WsAttempt[] = [];
        const transport = new TownMatchTransport({
            timers: { nowMs: () => 0 },
            reliable: recordWs(attempts, attempt => {
                if (attempt > 1) return admittedWs();
                if (failure === 'throw') throw new Error('socket closed');
                return createMessageDelivery('ws', failure === 'rejected'
                    ? { kind: 'refused', reason: 'unauthorized', detail: 'access refused' }
                    : { kind: 'failed', detail: 'offline' }).handle;
            }),
            realtime: { on: () => () => {}, send: async () => sent }
        });

        await expect(transport.write(ack, ['bob'])).rejects.toThrow();
        await transport.write({ ...ack, sequence: 6 }, ['bob']);
        await transport.write({ ...ack, sequence: 7 }, ['bob']);
        expect(attempts.map(attempt => JSON.parse(attempt.wire).sequence)).toEqual([5, 6]);
        transport.stop();
    });

    it.each([100, 1000])('keeps the host pump running and releases only the refused send at %i ms', async retryMs => {
        let now = 0;
        const pending = createMessageDelivery('ws', undefined);
        const attempts: WsAttempt[] = [];
        const transport = new TownMatchTransport({
            timers: { nowMs: () => now },
            reliable: recordWs(attempts, attempt => attempt === 1 ? pending.handle : admittedWs()),
            realtime: { on: () => () => {}, send: async () => sent }
        });
        const pump = transport.write(ack, ['bob']);
        const outcome = await Promise.race([
            pump.then(() => 'pump advanced'),
            new Promise(resolve => setTimeout(() => resolve('pump blocked'), 0))
        ]);
        expect(outcome).toBe('pump advanced');
        await transport.write({ ...ack, sequence: 6 }, ['bob']);
        now = retryMs;
        await transport.write({ ...ack, sequence: 7 }, ['bob']);
        pending.registry.record({
            kind: 'admission', carrier: 'ws', atMs: now, msgId: pending.handle.msgId,
            traceId: pending.handle.traceId, trackedReceiptAlgo: 'none',
            verdict: { kind: 'refused', reason: 'unauthorized', detail: 'disconnected' }
        });
        // Let the admission observation settle before the next host pump issues its retry.
        await new Promise(resolve => setTimeout(resolve, 0));
        await transport.write({ ...ack, sequence: 8 }, ['bob']);
        expect(attempts.map(attempt => JSON.parse(attempt.wire).sequence)).toEqual(retryMs === 100 ? [5, 8] : [5, 7]);
        transport.stop();
    });

    it('resends lost agreement without flooding slow peers, and immediately reaches a newly joined peer', async () => {
        let now = 0;
        const attempts: WsAttempt[] = [];
        const transport = new TownMatchTransport({
            timers: { nowMs: () => now },
            reliable: recordWs(attempts, admittedWs),
            realtime: { on: () => () => {}, send: async () => sent }
        });
        async function pump(sequence: number, recipients: readonly string[]) {
            await transport.write({ ...ack, sequence }, recipients);
        }

        await pump(5, ['bob']);
        now = 100;
        await pump(6, ['bob', 'carol']);
        for (now = 200; now < 1000; now += 100) await pump(now, ['bob', 'carol']);
        expect(attempts.map(attempt => attempt.options?.recipientPeerIds)).toEqual([['bob'], ['carol']]);
        now = 1100;
        await pump(1000, ['bob', 'carol']);
        expect(attempts[2]?.options?.recipientPeerIds).toEqual(['bob', 'carol']);
        const next: TownMatchFrame = { ...frame, sequence: 1001, action: { kind: 'ack', digest: 'b'.repeat(64), proposalSequence: 7 } };
        await transport.write(next, ['bob', 'carol']);
        expect(JSON.parse(attempts[3].wire)).toEqual(next);
        transport.stop();
    });

    it('cannot start a fallback after the owning match stops during an RTC send', async () => {
        const attempts: WsAttempt[] = [];
        const pending = Promise.withResolvers<RallarRoomRealtimeSendResult>();
        const transport = new TownMatchTransport({
            timers: { nowMs: () => 0 },
            reliable: recordWs(attempts, unavailableWs),
            realtime: { on: () => () => {}, send: async () => await pending.promise }
        });
        const write = transport.write(frame, ['bob', 'carol']);
        transport.stop();
        pending.resolve(sent);
        await write;
        expect(attempts).toEqual([]);
    });
});
