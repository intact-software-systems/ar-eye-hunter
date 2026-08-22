import { createRallarMessagesFacade } from '@shared-web/browser/rallar-messages-facade.ts';
import type { RallarMessageHandler, RallarMessageSendResult } from '@shared-web/browser/rallar.ts';
import { describe, expect, it, vi } from 'vitest';

describe('Rallar messages facade factory', () => {
    it('delegates message methods through injected operations', async () => {
        const rtcResult = { transport: 'rtc' } as RallarMessageSendResult;
        const wsResult = { transport: 'ws' } as RallarMessageSendResult;
        const rtcUnsubscribe = vi.fn();
        const wsUnsubscribe = vi.fn();
        const createChannelStub = () => ({
            send: vi.fn(async () => rtcResult),
            sendRtc: vi.fn(async () => rtcResult),
            sendWs: vi.fn(async () => wsResult),
            onRtc: vi.fn(() => rtcUnsubscribe),
            onWs: vi.fn(() => wsUnsubscribe)
        });
        const channel = createChannelStub();
        const roomChannel = createChannelStub();
        const rtcHandler = vi.fn() as RallarMessageHandler<{ rtc: true; }>;
        const wsHandler = vi.fn() as RallarMessageHandler<{ ws: true; }>;
        const operations = {
            rtc: {
                send: vi.fn(async () => rtcResult),
                onMessage: vi.fn(() => rtcUnsubscribe)
            },
            ws: {
                send: vi.fn(async () => wsResult),
                onMessage: vi.fn(() => wsUnsubscribe)
            },
            channel: vi.fn(() => channel),
            room: vi.fn(() => roomChannel)
        };

        const facade = createRallarMessagesFacade(operations);

        await expect(facade.rtc.send({
            typeId: 'rtc.type',
            payload: { rtc: true },
            roomId: 'room-1'
        })).resolves.toBe(rtcResult);
        expect(
            facade.rtc.onMessage<{ rtc: true; }>('rtc.type', rtcHandler)
        ).toBe(rtcUnsubscribe);
        await expect(facade.ws.send({
            typeId: 'ws.type',
            payload: { ws: true },
            scope: 'all'
        })).resolves.toBe(wsResult);
        expect(facade.ws.onMessage<{ ws: true; }>('ws.type', wsHandler)).toBe(
            wsUnsubscribe
        );
        expect(facade.channel<{ ok: true; }>({ typeId: 'typed.type' })).toBe(
            channel
        );

        expect(operations.rtc.send).toHaveBeenCalledWith({
            typeId: 'rtc.type',
            payload: { rtc: true },
            roomId: 'room-1'
        });
        expect(operations.rtc.onMessage).toHaveBeenCalledWith(
            'rtc.type',
            rtcHandler
        );
        expect(operations.ws.send).toHaveBeenCalledWith({
            typeId: 'ws.type',
            payload: { ws: true },
            scope: 'all'
        });
        expect(operations.ws.onMessage).toHaveBeenCalledWith(
            'ws.type',
            wsHandler
        );
        expect(operations.channel).toHaveBeenCalledWith({
            typeId: 'typed.type'
        });
    });
});
