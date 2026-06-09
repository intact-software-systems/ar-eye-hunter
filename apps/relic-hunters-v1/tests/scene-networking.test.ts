import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    applyRelicMotionPayload,
    broadcastLocalPosition,
    createRelicMotionState,
    isRelicMotionEstimateFreshForPlayer,
    isRelicMotionPayload,
    RELIC_MOTION_LANE_ID,
    RELIC_MOTION_MAX_AGE_MS,
    RELIC_MOTION_OPEN_TIMEOUT_MS,
    RELIC_MOTION_PROTOCOL,
    resolveRelicMotionPosition,
    subscribeRelicScenePositionUpdates,
    type RelicMotionPayload,
    type RelicScenePositionRuntime,
} from '../src/game/scene/networking.ts';

const rallarMock = vi.hoisted(() => ({
    onJson: vi.fn(),
    readyPeerIds: vi.fn<() => readonly string[]>(),
    waitForRoomLane: vi.fn(),
    sendJson: vi.fn(),
}));

vi.mock('@shared-web/browser/rallar.ts', () => ({
    rallar: {
        rtc: {
            readyPeerIds: rallarMock.readyPeerIds,
            waitForRoomLane: rallarMock.waitForRoomLane,
        },
        realtime: {
            onJson: rallarMock.onJson,
            sendJson: rallarMock.sendJson,
        },
    },
}));

describe('Relic scene realtime motion networking', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rallarMock.readyPeerIds.mockReturnValue(['bob-session']);
        rallarMock.waitForRoomLane.mockResolvedValue({
            status: 'open',
            ready: [{ peerId: 'bob-session' }],
            notReady: [],
        });
        rallarMock.sendJson.mockResolvedValue([{
            peerId: 'bob-session',
            laneId: RELIC_MOTION_LANE_ID,
            result: { status: 'sent', bufferedAmount: 0 },
        }]);
    });

    it('waits for the realtime lane and sends local avatar motion over rallar.realtime', async () => {
        const runtime = sceneRuntime();

        await broadcastLocalPosition(runtime);

        expect(rallarMock.waitForRoomLane).toHaveBeenCalledWith(
            'room-1',
            RELIC_MOTION_LANE_ID,
            { connect: true, timeoutMs: 1000 },
        );
        expect(rallarMock.sendJson).toHaveBeenCalledWith(expect.objectContaining({
            laneId: RELIC_MOTION_LANE_ID,
            roomId: 'room-1',
            openTimeoutMs: RELIC_MOTION_OPEN_TIMEOUT_MS,
            key: 'relic-motion:alice-session',
            maxAgeMs: RELIC_MOTION_MAX_AGE_MS,
            data: expect.objectContaining({
                protocol: RELIC_MOTION_PROTOCOL,
                kind: 'relic-motion',
                pid: 'alice-session',
                roomId: 'entrance',
                x: 1.25,
                y: 0.65,
                z: -0.5,
                ox: 1.25,
                oz: -0.5,
                r: 0.75,
                phase: 'walk',
            }),
        }));
        expect(runtime.motion.diagnostics.lastSendStatus).toBe('sent');
    });

    it('does not send motion until a realtime room lane has a ready peer', async () => {
        rallarMock.readyPeerIds.mockReturnValue([]);
        rallarMock.waitForRoomLane.mockResolvedValue({
            status: 'empty',
            ready: [],
            notReady: [],
        });
        const runtime = sceneRuntime();

        await broadcastLocalPosition(runtime);

        expect(rallarMock.waitForRoomLane).toHaveBeenCalled();
        expect(rallarMock.sendJson).not.toHaveBeenCalled();
        expect(runtime.motion.diagnostics.lastSendStatus).toBe('not-ready');
    });

    it('subscribes to the realtime lane for incoming motion samples', () => {
        const unsubscribe = () => undefined;
        rallarMock.onJson.mockReturnValue(unsubscribe);
        const runtime = sceneRuntime();

        expect(subscribeRelicScenePositionUpdates(runtime)).toBe(unsubscribe);

        expect(rallarMock.onJson).toHaveBeenCalledWith(
            RELIC_MOTION_LANE_ID,
            expect.any(Function),
        );
    });

    it('resolves incoming room-relative avatar coordinates against the local scene map', () => {
        const position = resolveRelicMotionPosition(
            motionPayload({
                pid: 'bob-session',
                roomId: 'entrance',
                x: 999,
                z: 999,
                ox: 1.2,
                oz: -0.8,
            }),
            sceneRuntime().snapshot.value,
        );

        expect(position).toEqual([1.2, 0.65, -0.8]);
    });

    it('pushes received realtime motion into the Rallar Motion buffer', () => {
        const runtime = sceneRuntime();

        expect(applyRelicMotionPayload(
            runtime,
            motionPayload({
                pid: 'bob-session',
                roomId: 'entrance',
                ox: 0.5,
                oz: 0.75,
                r: 1.2,
                seq: 7,
            }),
            'bob-peer',
            1_000,
        )).toBe(true);

        const estimate = runtime.motion.buffer.sample('bob-session', 1_100);
        expect(estimate).toMatchObject({
            entityId: 'bob-session',
            position: [0.5, 0.65, 0.75],
            rotation: [0, 1.2, 0],
            metadata: {
                roomId: 'entrance',
                senderPeerId: 'bob-peer',
                phase: 'walk',
            },
        });
        expect(runtime.motion.diagnostics.acceptedSamples).toBe(1);
    });

    it('rejects duplicate and stale sequence samples', () => {
        const runtime = sceneRuntime();
        const first = motionPayload({ pid: 'bob-session', seq: 9 });

        expect(applyRelicMotionPayload(runtime, first, 'bob-peer', 1_000)).toBe(true);
        expect(applyRelicMotionPayload(runtime, first, 'bob-peer', 1_020)).toBe(false);
        expect(applyRelicMotionPayload(
            runtime,
            motionPayload({ pid: 'bob-session', seq: 8 }),
            'bob-peer',
            1_040,
        )).toBe(false);

        expect(runtime.motion.diagnostics.duplicateSamples).toBe(1);
        expect(runtime.motion.diagnostics.staleSamples).toBe(1);
    });

    it('rejects motion payloads that do not match the protocol schema', () => {
        expect(isRelicMotionPayload({ protocol: 'old', pid: 'bob-session' })).toBe(false);
        expect(isRelicMotionPayload(motionPayload({ pid: 'bob-session' }))).toBe(true);
    });

    it('treats motion estimates from a different room as stale for the player', () => {
        const runtime = sceneRuntime();
        applyRelicMotionPayload(
            runtime,
            motionPayload({ pid: 'bob-session', roomId: 'entrance' }),
            'bob-peer',
            1_000,
        );

        const estimate = runtime.motion.buffer.sample('bob-session', 1_100);
        expect(isRelicMotionEstimateFreshForPlayer(estimate, 'hallway', 1_100)).toBe(false);
        expect(isRelicMotionEstimateFreshForPlayer(estimate, 'entrance', 1_100)).toBe(true);
    });
});

function motionPayload(overrides: Partial<RelicMotionPayload> = {}): RelicMotionPayload {
    return {
        protocol: RELIC_MOTION_PROTOCOL,
        version: 1,
        kind: 'relic-motion',
        pid: 'alice-session',
        roomId: 'entrance',
        seq: 1,
        x: 0,
        y: 0.65,
        z: 0,
        ox: 0,
        oz: 0,
        r: 0,
        phase: 'walk',
        sentAtEpochMs: 900,
        ...overrides,
    };
}

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
        motionPhase: { value: 'walk' },
        motion: createRelicMotionState(),
    };
}
