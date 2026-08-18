import { describe, expect, it, vi } from 'vitest';
import { createRallarRealtimeFacade } from '@shared-web/browser/rallar-realtime-facade.ts';
import type {
    RallarRealtimeHandler,
    RallarRealtimeJsonLane,
    RallarRealtimeLaneHealth,
    RallarRealtimeSendResult,
} from '@shared-web/browser/rallar.ts';

describe('Rallar realtime facade factory', () => {
    it('delegates realtime methods through injected operations', async () => {
        const jsonResults = [{
            peerId: 'peer-1',
            laneId: 'lane-json',
            result: {} as RallarRealtimeSendResult['result'],
        }] satisfies readonly RallarRealtimeSendResult[];
        const binaryResults = [{
            peerId: 'peer-2',
            laneId: 'lane-binary',
            result: {} as RallarRealtimeSendResult['result'],
        }] satisfies readonly RallarRealtimeSendResult[];
        const lane = {
            send: vi.fn(async () => jsonResults),
            on: vi.fn(() => vi.fn()),
        } satisfies RallarRealtimeJsonLane<{ ok: true }>;
        const health = [{
            peerId: 'peer-1',
            laneId: 'lane-json',
        }] satisfies readonly RallarRealtimeLaneHealth[];
        const jsonUnsubscribe = vi.fn();
        const binaryUnsubscribe = vi.fn();
        const jsonHandler = vi.fn() as RallarRealtimeHandler<{ ok: true }>;
        const binaryHandler = vi.fn() as RallarRealtimeHandler<ArrayBuffer>;
        const operations = {
            sendJson: vi.fn(async () => jsonResults),
            sendBinary: vi.fn(async () => binaryResults),
            onJson: vi.fn(() => jsonUnsubscribe),
            onBinary: vi.fn(() => binaryUnsubscribe),
            json: vi.fn(() => lane),
            room: vi.fn((): never => {
                throw new Error('This test does not exercise the room channel.');
            }),
            health: vi.fn(() => health),
        };

        const facade = createRallarRealtimeFacade(operations);
        const binaryData = new Uint8Array([1, 2, 3]);

        await expect(facade.sendJson({
            data: { ok: true },
            laneId: 'lane-json',
        })).resolves.toBe(jsonResults);
        await expect(facade.sendBinary({
            data: binaryData,
            laneId: 'lane-binary',
        })).resolves.toBe(binaryResults);
        expect(facade.onJson('lane-json', jsonHandler)).toBe(jsonUnsubscribe);
        expect(facade.onBinary('lane-binary', binaryHandler)).toBe(
            binaryUnsubscribe,
        );
        expect(facade.json<{ ok: true }>({ laneId: 'lane-json' })).toBe(lane);
        expect(facade.health({ peerIds: ['peer-1'] })).toBe(health);

        expect(operations.sendJson).toHaveBeenCalledWith({
            data: { ok: true },
            laneId: 'lane-json',
        });
        expect(operations.sendBinary).toHaveBeenCalledWith({
            data: binaryData,
            laneId: 'lane-binary',
        });
        expect(operations.onJson).toHaveBeenCalledWith('lane-json', jsonHandler);
        expect(operations.onBinary).toHaveBeenCalledWith(
            'lane-binary',
            binaryHandler,
        );
        expect(operations.json).toHaveBeenCalledWith({ laneId: 'lane-json' });
        expect(operations.health).toHaveBeenCalledWith({ peerIds: ['peer-1'] });
    });
});
