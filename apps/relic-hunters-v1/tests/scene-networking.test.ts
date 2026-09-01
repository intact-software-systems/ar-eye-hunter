import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import type { RallarFacade, RallarRoomRealtimeJsonChannel, RallarRoomRealtimeJsonDefaults } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../../../packages/tests/shared-web/authoritative-group-fixtures.ts';

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
    type RelicScenePositionRuntime
} from '../src/game/scene/networking.ts';

const rallarMock = vi.hoisted(() => ({
    onJson: vi.fn<RallarFacade['realtime']['onJson']>(),
    room: vi.fn<(defaults: RallarRoomRealtimeJsonDefaults) => void>(),
    roomSend: vi.fn<RallarRoomRealtimeJsonChannel<RelicMotionPayload>['send']>(),
    roomState: vi.fn<RallarFacade['rooms']['state']>()
}));

vi.mock(import('@shared-web/browser/rallar.ts'), async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        rallar: {
            ...original.rallar,
            realtime: {
                ...original.rallar.realtime,
                onJson: rallarMock.onJson,
                room: <T>(defaults: RallarRoomRealtimeJsonDefaults = {}) => {
                    rallarMock.room(defaults);
                    return {
                        ...original.rallar.realtime.room<T>(defaults),
                        send: async (data, options) => {
                            if (!isRelicMotionPayload(data)) {
                                throw new Error('Unexpected motion payload at the room send boundary.');
                            }
                            return rallarMock.roomSend(data, options);
                        }
                    };
                }
            },
            rooms: { ...original.rallar.rooms, state: rallarMock.roomState }
        }
    };
});

const gameRoomRef: GroupRef = { applicationId: 'relic-hunters', workspaceId: 'expeditions', groupId: 'room-1' };

describe('Relic scene realtime motion networking', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rallarMock.room.mockReset();
        rallarMock.roomSend.mockResolvedValue({
            status: 'sent',
            peerIds: ['bob-session'],
            desiredPeerIds: ['bob-session'],
            results: [{
                peerId: 'bob-session',
                laneId: RELIC_MOTION_LANE_ID,
                result: { status: 'sent', bufferedAmount: 0 }
            }],
            transport: 'rtc',
            laneId: RELIC_MOTION_LANE_ID
        });
        rallarMock.roomState.mockReturnValue(createRoomState('flowing'));
    });

    it('sends local avatar motion through a Rallar room realtime channel', async () => {
        const runtime = sceneRuntime();

        await broadcastLocalPosition(runtime);

        expect(rallarMock.room).toHaveBeenCalledWith(expect.objectContaining({
            laneId: RELIC_MOTION_LANE_ID,
            roomRef: gameRoomRef,
            openTimeoutMs: RELIC_MOTION_OPEN_TIMEOUT_MS,
            waitTimeoutMs: 1000
        }));
        expect(rallarMock.roomSend).toHaveBeenCalledWith(
            expect.objectContaining({
                protocol: RELIC_MOTION_PROTOCOL,
                kind: 'relic-motion',
                version: 2,
                roomRef: gameRoomRef,
                pid: 'alice-session',
                roomId: 'entrance',
                y: 0.65,
                ox: 1.25,
                oz: -0.5,
                r: 0.75,
                phase: 'walk'
            }),
            expect.objectContaining({
                key: 'relic-motion:alice-session',
                maxAgeMs: RELIC_MOTION_MAX_AGE_MS
            })
        );
        expect(runtime.motion.diagnostics.lastSendStatus).toBe('sent');
    });

    it('does not send motion until a realtime room lane has a ready peer', async () => {
        rallarMock.roomSend.mockResolvedValue({
            status: 'not-ready',
            peerIds: [],
            desiredPeerIds: ['bob-session'],
            results: [],
            transport: 'rtc',
            laneId: RELIC_MOTION_LANE_ID
        });
        const runtime = sceneRuntime();

        await broadcastLocalPosition(runtime);

        expect(runtime.motion.diagnostics.lastSendStatus).toBe('not-ready');
    });

    it('does not advance or send per-frame motion while room transport is halted', async () => {
        rallarMock.roomState.mockReturnValue(createRoomState('halted'));
        rallarMock.room.mockImplementation(() => {
            throw new Error('Halted motion cannot resolve a realtime room.');
        });
        rallarMock.roomSend.mockImplementation(() => {
            throw new Error('Halted motion cannot send.');
        });
        const runtime = sceneRuntime();

        await broadcastLocalPosition(runtime);

        expect(runtime.motion.seq.value).toBe(0);
        expect(runtime.motion.diagnostics).toMatchObject({
            laneReady: false,
            readyPeerCount: 0,
            lastSendStatus: 'halted',
            lastSendReason: 'Room transport is halted by authoritative group state.'
        });
    });

    it('keeps motion eligible after a room attempt reports a late halt', async () => {
        const runtime = sceneRuntime();
        rallarMock.roomSend.mockResolvedValueOnce({
            transport: 'rtc',
            status: 'halted',
            laneId: RELIC_MOTION_LANE_ID,
            peerIds: [],
            desiredPeerIds: [],
            results: [],
            reason: 'Room transport changed while waiting for peers.'
        });

        await broadcastLocalPosition(runtime);

        expect(runtime.motion.seq.value).toBe(1);
        expect(runtime.motion.diagnostics.lastSendStatus).toBe('halted');
        await broadcastLocalPosition(runtime);
        expect(runtime.motion.seq.value).toBe(2);
        expect(rallarMock.roomSend.mock.calls.at(-1)?.[0]).toMatchObject({ seq: 2 });
        expect(runtime.motion.diagnostics.lastSendStatus).toBe('sent');
    });

    it('reports a thrown send failure and leaves the next motion frame eligible', async () => {
        const runtime = sceneRuntime();
        runtime.motion.diagnostics.readyPeerCount = 1;
        rallarMock.roomSend.mockRejectedValueOnce('RTC transport unavailable');

        await broadcastLocalPosition(runtime);

        expect(runtime.motion.diagnostics).toMatchObject({
            laneReady: false,
            readyPeerCount: 0,
            lastSendStatus: 'failed',
            lastSendReason: 'RTC transport unavailable'
        });
        await broadcastLocalPosition(runtime);
        expect(runtime.motion.diagnostics.lastSendStatus).toBe('sent');
    });

    it('delivers subscribed motion and releases the subscription on cleanup', async () => {
        let subscribed = true;
        rallarMock.onJson.mockReturnValue(() => {
            subscribed = false;
        });
        const runtime = sceneRuntime();
        const unsubscribe = subscribeRelicScenePositionUpdates(runtime);
        const registration = rallarMock.onJson.mock.calls.at(-1);
        if (!registration) {
            throw new Error('Motion reception was not registered.');
        }
        const [laneId, receive] = registration;
        const data = motionPayload({ pid: 'bob-session', ox: 2, oz: 3 });
        await receive({
            peerId: 'bob-peer',
            laneId,
            data,
            event: new MessageEvent('message', { data: JSON.stringify(data) }),
            receivedAtEpochMs: 1_000
        });

        expect(laneId).toBe('realtime');
        expect(runtime.motion.buffer.sample('bob-session', 1_100)?.position).toEqual([2, 0.65, 3]);
        unsubscribe();
        expect(subscribed).toBe(false);
    });

    it('resolves incoming room-relative avatar coordinates against the local scene map', () => {
        const position = resolveRelicMotionPosition(
            motionPayload({
                pid: 'bob-session',
                roomId: 'entrance',
                ox: 1.2,
                oz: -0.8
            }),
            createSceneSnapshot()
        );

        expect(position).toEqual([1.2, 0.65, -0.8]);
    });

    it('pushes received realtime motion into the Rallar Motion buffer', () => {
        const runtime = sceneRuntime();

        expect(applyRelicMotionPayload({
            runtime: runtime,
            payload: motionPayload({
                pid: 'bob-session',
                roomId: 'entrance',
                ox: 0.5,
                oz: 0.75,
                r: 1.2,
                seq: 7
            }),
            senderPeerId: 'bob-peer',
            receivedAtEpochMs: 1_000
        })).toBe(true);

        const estimate = runtime.motion.buffer.sample('bob-session', 1_100);
        expect(estimate).toMatchObject({
            entityId: 'bob-session',
            position: [0.5, 0.65, 0.75],
            rotation: [0, 1.2, 0],
            metadata: {
                roomId: 'entrance',
                senderPeerId: 'bob-peer',
                phase: 'walk'
            }
        });
        expect(runtime.motion.diagnostics.acceptedSamples).toBe(1);
    });

    it.each([
        { applicationId: 'other-app', workspaceId: 'expeditions', groupId: 'room-1' },
        { applicationId: 'relic-hunters', workspaceId: 'other-workspace', groupId: 'room-1' },
        { applicationId: 'relic-hunters', workspaceId: 'expeditions', groupId: 'other-room' }
    ])('rejects motion from a different game scope: %j', (roomRef) => {
        const runtime = sceneRuntime();
        const payload = { ...motionPayload({ pid: 'bob-session' }), roomRef };

        expect(applyRelicMotionPayload({ runtime: runtime, payload: payload, senderPeerId: 'bob-peer', receivedAtEpochMs: 1_000 })).toBe(false);
        expect(runtime.motion.buffer.sample('bob-session', 1_100)).toBeUndefined();
        expect(runtime.motion.diagnostics.acceptedSamples).toBe(0);
    });

    it('rejects motion without the complete game room identity', () => {
        const runtime = sceneRuntime();
        const payload = { ...motionPayload({ pid: 'bob-session' }), roomRef: undefined };

        expect(applyRelicMotionPayload({ runtime: runtime, payload: payload, senderPeerId: 'bob-peer', receivedAtEpochMs: 1_000 })).toBe(false);
        expect(runtime.motion.buffer.sample('bob-session', 1_100)).toBeUndefined();
    });

    it('rejects motion whose dungeon room is absent from the authoritative scene map', () => {
        const runtime = sceneRuntime();
        runtime.snapshot.value = { ...createSceneSnapshot(), map: [] };

        expect(applyRelicMotionPayload({
            runtime,
            payload: motionPayload({ pid: 'bob-session' }),
            senderPeerId: 'bob-peer',
            receivedAtEpochMs: 1_000
        })).toBe(false);
        expect(runtime.motion.buffer.sample('bob-session', 1_100)).toBeUndefined();
    });

    it('rejects duplicate and stale sequence samples', () => {
        const runtime = sceneRuntime();
        const first = motionPayload({ pid: 'bob-session', seq: 9 });

        expect(applyRelicMotionPayload({ runtime: runtime, payload: first, senderPeerId: 'bob-peer', receivedAtEpochMs: 1_000 })).toBe(true);
        expect(applyRelicMotionPayload({ runtime: runtime, payload: first, senderPeerId: 'bob-peer', receivedAtEpochMs: 1_020 })).toBe(false);
        expect(
            applyRelicMotionPayload({
                runtime: runtime,
                payload: motionPayload({ pid: 'bob-session', seq: 8 }),
                senderPeerId: 'bob-peer',
                receivedAtEpochMs: 1_040
            })
        ).toBe(false);

        expect(runtime.motion.diagnostics.duplicateSamples).toBe(1);
        expect(runtime.motion.diagnostics.staleSamples).toBe(1);
    });

    it('rejects motion payloads that do not match the protocol schema', () => {
        expect(isRelicMotionPayload({ ...motionPayload(), protocol: 'relic.motion.v1', version: 1 })).toBe(false);
        expect(isRelicMotionPayload({ ...motionPayload(), roomRef: { applicationId: 'relic-hunters', groupId: 'room-1' } })).toBe(false);
        expect(isRelicMotionPayload(motionPayload({ pid: 'bob-session' }))).toBe(true);
    });

    it('treats motion estimates from a different room as stale for the player', () => {
        const runtime = sceneRuntime();
        applyRelicMotionPayload({
            runtime: runtime,
            payload: motionPayload({ pid: 'bob-session', roomId: 'entrance' }),
            senderPeerId: 'bob-peer',
            receivedAtEpochMs: 1_000
        });

        const estimate = runtime.motion.buffer.sample('bob-session', 1_100);
        expect(isRelicMotionEstimateFreshForPlayer(estimate, 'hallway', 1_100)).toBe(false);
        expect(isRelicMotionEstimateFreshForPlayer(estimate, 'entrance', 1_100)).toBe(true);
    });
});

function motionPayload(overrides: Partial<RelicMotionPayload> = {}): RelicMotionPayload {
    return {
        protocol: RELIC_MOTION_PROTOCOL,
        version: 2,
        roomRef: gameRoomRef,
        kind: 'relic-motion',
        pid: 'alice-session',
        roomId: 'entrance',
        seq: 1,
        y: 0.65,
        ox: 0,
        oz: 0,
        r: 0,
        phase: 'walk',
        sentAtEpochMs: 900,
        ...overrides
    };
}

function sceneRuntime(): RelicScenePositionRuntime {
    return {
        snapshot: { value: createSceneSnapshot() },
        localPlayerId: { value: 'alice-session' },
        rtcReady: { value: true },
        roamOffset: new Vector3(1.25, 0, -0.5),
        cameraYaw: { value: 0.75 },
        motionPhase: { value: 'walk' },
        motion: createRelicMotionState()
    };
}

function createSceneSnapshot(): RelicPublicSnapshot {
    return {
        protocolVersion: 1,
        gameId: 'room-1',
        roomId: 'room-1',
        phase: 'planning',
        round: 1,
        maxRounds: 10,
        updatedAtEpochMs: 1,
        roundTimeLimitMs: 60_000,
        map: [{ id: 'entrance', name: 'Entrance', kind: 'entrance', x: 0, z: 0, neighbors: [] }],
        relics: [],
        roomInvestigations: [],
        players: ['alice-session', 'bob-session'].map((playerId) => ({
            playerId,
            username: playerId,
            characterId: 'kael-ironstride',
            roomId: 'entrance',
            health: 3,
            escaped: false,
            defeated: false,
            score: 0,
            relicIds: []
        })),
        submittedPlayerIds: [],
        events: [],
        winnerIds: []
    };
}

function createRoomState(transportState: 'flowing' | 'halted'): ReturnType<RallarFacade['rooms']['state']> {
    const snapshot = createGroupSnapshotFixture({ ...gameRoomRef, sessionIds: ['alice-session', 'bob-session'] });
    return {
        rooms: [],
        members: [],
        currentRoomId: gameRoomRef.groupId,
        currentRoomRef: gameRoomRef,
        currentRoom: { ...snapshot, group: { ...snapshot.group, transportState } }
    };
}
