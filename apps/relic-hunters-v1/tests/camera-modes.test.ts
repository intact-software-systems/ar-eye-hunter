import { describe, expect, it } from 'vitest';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import {
    AVATAR_CAMERA_FOLLOW_HOLD_MS,
    AVATAR_CAMERA_ZOOM_OUT_MS,
    avatarCameraReturnState,
    blendRelicCameraPose,
    deriveRelicCameraMode,
    planRoomFlyoverCameraPose,
    planTacticalCameraPose,
    tacticalFocusRooms,
} from '../src/game/scene/cameraModes.ts';

const rooms: readonly RelicRoom[] = [
    { id: 'entrance', name: 'Entrance', kind: 'entrance', x: 0, z: -6, neighbors: ['hallway', 'storage'] },
    { id: 'hallway', name: 'Hallway', kind: 'hallway', x: 0, z: -3, neighbors: ['entrance', 'shrine'] },
    { id: 'storage', name: 'Storage', kind: 'storage', x: -4, z: -3, neighbors: ['entrance', 'trap'] },
    { id: 'trap', name: 'Trap Room', kind: 'trap', x: -4, z: 0, neighbors: ['storage', 'shrine'] },
    { id: 'shrine', name: 'Shrine', kind: 'shrine', x: 0, z: 0, neighbors: ['hallway', 'trap', 'treasure', 'exit'] },
    { id: 'treasure', name: 'Treasure', kind: 'treasure', x: 4, z: 0, neighbors: ['shrine'] },
    { id: 'exit', name: 'Exit', kind: 'exit', x: 0, z: 3, neighbors: ['shrine'] },
];

describe('camera modes', () => {
    it('uses tactical mode for idle planning instead of roam', () => {
        expect(deriveRelicCameraMode({
            snapshot: snapshot('planning'),
            localPlayerId: 'alice-session',
            isRoaming: false,
            isInspecting: false,
        })).toBe('tactical');
    });

    it('preserves roam and inspection modes when the player is actively using them', () => {
        expect(deriveRelicCameraMode({
            snapshot: snapshot('planning'),
            localPlayerId: 'alice-session',
            isRoaming: true,
            isInspecting: false,
        })).toBe('roam');
        expect(deriveRelicCameraMode({
            snapshot: snapshot('planning'),
            localPlayerId: 'alice-session',
            isRoaming: true,
            isInspecting: true,
        })).toBe('inspection');
    });

    it('keeps lobby and event-focus modes distinct from planning overview', () => {
        expect(deriveRelicCameraMode({
            snapshot: snapshot('lobby'),
            localPlayerId: 'alice-session',
            isRoaming: false,
            isInspecting: false,
        })).toBe('lobby');
        expect(deriveRelicCameraMode({
            snapshot: snapshot('finished'),
            localPlayerId: 'alice-session',
            isRoaming: false,
            isInspecting: false,
            focusRoomId: 'treasure',
        })).toBe('event-focus');
    });

    it('frames current room, neighbors, objectives, and occupied rooms in tactical mode', () => {
        const shot = snapshot('planning', {
            playerRooms: {
                'alice-session': 'entrance',
                'bob-session': 'exit',
            },
        });
        const currentRoom = rooms[0];
        const focusRooms = tacticalFocusRooms({
            snapshot: shot,
            currentRoom,
            selectedRoomId: 'treasure',
            objectiveTargetRoomId: 'shrine',
        });

        expect(focusRooms.map((room) => room.id)).toEqual([
            'entrance',
            'hallway',
            'storage',
            'treasure',
            'shrine',
            'exit',
        ]);

        const pose = planTacticalCameraPose({
            snapshot: shot,
            currentRoom,
            selectedRoomId: 'treasure',
            objectiveTargetRoomId: 'shrine',
            aspectRatio: 16 / 9,
        });
        expect(pose.position.y).toBeGreaterThan(20);
        expect(pose.position.z).toBeLessThan(pose.target.z);
        expect(pose.fov).toBeLessThan(0.8);
    });

    it('holds the avatar camera after movement before easing back to tactical', () => {
        expect(avatarCameraReturnState({
            snapshotPhase: 'planning',
            lastRoamInputMs: 1_000,
            nowMs: 1_000 + AVATAR_CAMERA_FOLLOW_HOLD_MS - 1,
        })).toEqual({
            phase: 'follow',
            progress: 0,
        });

        const midpoint = avatarCameraReturnState({
            snapshotPhase: 'planning',
            lastRoamInputMs: 1_000,
            nowMs: 1_000 + AVATAR_CAMERA_FOLLOW_HOLD_MS + AVATAR_CAMERA_ZOOM_OUT_MS / 2,
        });
        expect(midpoint.phase).toBe('zoom-out');
        expect(midpoint.progress).toBeCloseTo(0.5);

        expect(avatarCameraReturnState({
            snapshotPhase: 'planning',
            lastRoamInputMs: 1_000,
            nowMs: 1_000 + AVATAR_CAMERA_FOLLOW_HOLD_MS + AVATAR_CAMERA_ZOOM_OUT_MS + 1,
        })).toEqual({
            phase: 'inactive',
            progress: 1,
        });
    });

    it('blends avatar follow and tactical camera poses', () => {
        const pose = blendRelicCameraPose(
            {
                position: new Vector3(0, 2, 0),
                target: new Vector3(0, 1, 0),
                fov: 0.94,
            },
            {
                position: new Vector3(10, 22, -20),
                target: new Vector3(4, 1, -6),
                fov: 0.72,
            },
            0.25,
        );

        expect(pose.position.x).toBeCloseTo(2.5);
        expect(pose.position.y).toBeCloseTo(7);
        expect(pose.position.z).toBeCloseTo(-5);
        expect(pose.target.x).toBeCloseTo(1);
        expect(pose.target.z).toBeCloseTo(-1.5);
        expect(pose.fov).toBeCloseTo(0.885);
    });

    it('flies over room centers before returning to the captured camera pose', () => {
        const returnPose = {
            position: new Vector3(2, 6, -8),
            target: new Vector3(1, 1, -3),
            fov: 0.9,
        };
        const start = planRoomFlyoverCameraPose({
            rooms,
            progress: 0,
            returnPose,
        });
        const middle = planRoomFlyoverCameraPose({
            rooms,
            progress: 0.5,
            returnPose,
        });
        const end = planRoomFlyoverCameraPose({
            rooms,
            progress: 1,
            returnPose,
        });

        expect(start.target.z).toBeLessThan(middle.target.z);
        expect(end.position.x).toBeCloseTo(returnPose.position.x);
        expect(end.position.y).toBeCloseTo(returnPose.position.y);
        expect(end.position.z).toBeCloseTo(returnPose.position.z);
        expect(end.target.x).toBeCloseTo(returnPose.target.x);
        expect(end.target.z).toBeCloseTo(returnPose.target.z);
        expect(end.fov).toBeCloseTo(returnPose.fov);
    });
});

function snapshot(
    phase: RelicPublicSnapshot['phase'],
    options: Readonly<{ playerRooms?: Readonly<Record<string, string>> }> = {},
): RelicPublicSnapshot {
    return {
        protocolVersion: 1,
        gameId: 'room-1',
        roomId: 'room-1',
        phase,
        round: 1,
        maxRounds: 10,
        updatedAtEpochMs: Date.now(),
        roundTimeLimitMs: 180_000,
        map: rooms,
        relics: [],
        roomInvestigations: [],
        players: [
            {
                playerId: 'alice-session',
                username: 'Alice',
                characterId: 'kael-ironstride',
                roomId: options.playerRooms?.['alice-session'] ?? 'entrance',
                health: 3,
                escaped: false,
                defeated: false,
                score: 0,
                relicIds: [],
            },
            {
                playerId: 'bob-session',
                username: 'Bob',
                characterId: 'nyra-vale',
                roomId: options.playerRooms?.['bob-session'] ?? 'hallway',
                health: 3,
                escaped: false,
                defeated: false,
                score: 0,
                relicIds: [],
            },
        ],
        submittedPlayerIds: [],
        events: [],
        winnerIds: [],
    };
}
