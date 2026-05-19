import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    broadcastLocalPosition,
    isRemotePositionFreshForPlayer,
    resolveRelicPosUpdatePosition,
    type RelicScenePositionRuntime,
    subscribeRelicScenePositionUpdates,
} from '../src/game/scene/networking.ts';

const rallarMock = vi.hoisted(() => ({
    onMessage: vi.fn(),
    readyPeerIds: vi.fn<() => readonly string[]>(),
    send: vi.fn(async () => ({})),
}));

vi.mock('@shared-web/browser/rallar.ts', () => ({
    rallar: {
        rtc: {
            readyPeerIds: rallarMock.readyPeerIds,
        },
        messages: {
            rtc: {
                onMessage: rallarMock.onMessage,
                send: rallarMock.send,
            },
        },
    },
}));

describe('Relic scene networking', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rallarMock.readyPeerIds.mockReturnValue(['bob-session']);
    });

    it('targets ready RTC peers when broadcasting local avatar position', () => {
        rallarMock.readyPeerIds.mockReturnValue([
            'bob-session',
            'bob-session',
            'cara-session',
        ]);
        const runtime = sceneRuntime();

        broadcastLocalPosition(runtime);

        expect(rallarMock.send).toHaveBeenCalledWith({
            roomId: 'room-1',
            typeId: 'relic.pos',
            payload: {
                pid: 'alice-session',
                roomId: 'entrance',
                x: 1.25,
                z: -0.5,
                ox: 1.25,
                oz: -0.5,
                r: 0.75,
            },
            nextHopPeerIds: ['bob-session', 'cara-session'],
            ttlHops: 1,
            reliability: 'best-effort',
        });
        expect(runtime.lastPosBroadcastMs.value).toBeGreaterThanOrEqual(0);
    });

    it('does not throttle future broadcasts while no RTC peers are routable', () => {
        rallarMock.readyPeerIds.mockReturnValue([]);
        const runtime = sceneRuntime();

        broadcastLocalPosition(runtime);

        expect(rallarMock.send).not.toHaveBeenCalled();
        expect(runtime.lastPosBroadcastMs.value).toBe(-1_000);
    });

    it('resolves incoming room-relative avatar coordinates against the local scene map', () => {
        const position = resolveRelicPosUpdatePosition(
            {
                pid: 'bob-session',
                roomId: 'entrance',
                x: 999,
                z: 999,
                ox: 1.2,
                oz: -0.8,
                r: 0,
            },
            sceneRuntime().snapshot.value,
        );

        expect(position).toEqual({
            x: 1.2,
            z: -0.8,
        });
    });

    it('stores received avatar positions by player id', () => {
        let handler: ((message: { payload: unknown }) => void) | undefined;
        rallarMock.onMessage.mockImplementation((_typeId: string, nextHandler: typeof handler) => {
            handler = nextHandler;
            return () => undefined;
        });
        const runtime = sceneRuntime();

        subscribeRelicScenePositionUpdates(runtime);
        handler?.({
            payload: {
                pid: 'bob-session',
                roomId: 'entrance',
                x: 999,
                z: 999,
                ox: 0.5,
                oz: 0.75,
                r: 1.2,
            },
        });

        expect(runtime.remotePositions.get('bob-session')).toMatchObject({
            x: 0.5,
            z: 0.75,
            yaw: 1.2,
            roomId: 'entrance',
        });
    });

    it('rejects fresh RTC avatar positions from a stale snapshot room', () => {
        expect(isRemotePositionFreshForPlayer({
            x: 0,
            z: 0,
            yaw: 0,
            roomId: 'entrance',
            t: 1_000,
        }, 'hallway', 1_010)).toBe(false);
        expect(isRemotePositionFreshForPlayer({
            x: 0,
            z: 0,
            yaw: 0,
            roomId: 'hallway',
            t: 1_000,
        }, 'hallway', 1_010)).toBe(true);
    });
});

function sceneRuntime(): RelicScenePositionRuntime {
    return {
        snapshot: {
            value: {
                roomId: 'room-1',
                players: [
                    {
                        playerId: 'alice-session',
                        roomId: 'entrance',
                        escaped: false,
                        defeated: false,
                    },
                    {
                        playerId: 'bob-session',
                        roomId: 'entrance',
                        escaped: false,
                        defeated: false,
                    },
                ],
                map: [
                    {
                        id: 'entrance',
                        x: 0,
                        z: 0,
                    },
                ],
            } as unknown as RelicScenePositionRuntime['snapshot']['value'],
        },
        localPlayerId: { value: 'alice-session' },
        rtcReady: { value: true },
        roamOffset: { x: 1.25, z: -0.5 } as RelicScenePositionRuntime['roamOffset'],
        cameraYaw: { value: 0.75 },
        remotePositions: new Map(),
        lastPosBroadcastMs: { value: -1_000 },
    };
}
