import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';
import { describe, expect, it } from 'vitest';
import {
    blackHumourSignForRoom,
    calculateFacilityBounds,
    facilityRoomCallsign,
    neonFlyoverRouteRooms,
    planNeonAvatarCameraPose,
    planNeonFirstPersonCameraPose,
    planNeonFlyoverCameraPose,
    planNeonOverviewCameraPose,
    planNeonTacticalCameraPose,
    projectFacilityMapPoint,
    RELIC_SCENE_NEXT_VISUAL_CONTRACT,
    shouldShowFacilityMapLabel
} from '../src/game/scene/relicSceneNextModel.ts';

const map: readonly RelicRoom[] = [
    { id: 'entrance', name: 'Corporate Intake Gate', kind: 'entrance', x: 0, z: -1, neighbors: ['hall'] },
    { id: 'hall', name: 'Queue Optimization Hall', kind: 'hallway', x: 0, z: 0, neighbors: ['entrance', 'trap', 'exit'] },
    { id: 'trap', name: 'Safety Audit Floor', kind: 'trap', x: -1, z: 0, neighbors: ['hall'] },
    { id: 'treasure', name: 'Executive Bonus Vault', kind: 'treasure', x: 1, z: 0, neighbors: ['hall'] },
    { id: 'exit', name: 'Gift Shop Evacuation', kind: 'exit', x: 0, z: 1, neighbors: ['hall'] }
];

describe('RelicSceneNext model helpers', () => {
    it('projects facility rooms into a padded tactical map area', () => {
        const bounds = calculateFacilityBounds(map);

        expect(projectFacilityMapPoint(map[0], bounds)).toEqual({ x: 50, y: 11 });
        expect(projectFacilityMapPoint(map[4], bounds)).toEqual({ x: 50, y: 89 });
        expect(projectFacilityMapPoint(map[2], bounds).x).toBe(11);
        expect(projectFacilityMapPoint(map[3], bounds).x).toBe(89);
    });

    it('keeps minimap labels selective so room cards cannot overlap everything', () => {
        expect(shouldShowFacilityMapLabel({
            room: map[1],
            selectedRoomId: undefined,
            localRoomId: 'entrance',
            exitRoomId: 'exit'
        })).toBe(false);
        expect(shouldShowFacilityMapLabel({
            room: map[1],
            selectedRoomId: 'hall',
            localRoomId: 'entrance',
            exitRoomId: 'exit'
        })).toBe(true);
        expect(shouldShowFacilityMapLabel({
            room: map[4],
            selectedRoomId: undefined,
            localRoomId: 'entrance',
            exitRoomId: 'exit'
        })).toBe(true);
    });

    it('produces dry dystopian signage without hiding the room identity', () => {
        expect(facilityRoomCallsign(map[3])).toBe('TRE-EB');
        expect(blackHumourSignForRoom({ id: 'trap', kind: 'trap' })).toMatch(/Safety|floor/);
        expect(blackHumourSignForRoom({ id: 'exit', kind: 'exit' })).toMatch(/Exit|evacuation/i);
    });

    it('frames the local tactical cluster lower and closer than the legacy full-map flyout', () => {
        const pose = planNeonTacticalCameraPose({
            snapshot: snapshot(),
            localPlayerId: 'alice',
            selectedRoomId: 'trap',
            aspectRatio: 16 / 9
        });

        expect(pose.position.y).toBeGreaterThanOrEqual(13);
        expect(pose.position.y).toBeLessThan(26);
        expect(pose.position.z).toBeLessThan(pose.target.z);
        expect(pose.fov).toBeGreaterThan(0.72);
    });

    it('places avatar view behind and above the local samurai', () => {
        const avatarPosition = new Vector3(3, 0.72, 5);
        const pose = planNeonAvatarCameraPose({ avatarPosition, cameraYaw: 0, cameraPitch: 0 });

        expect(pose.position.y).toBeGreaterThan(avatarPosition.y + 2);
        expect(pose.position.z).toBeLessThan(avatarPosition.z);
        expect(pose.target.z).toBeGreaterThan(avatarPosition.z);
        expect(pose.fov).toBeGreaterThan(0.8);
    });

    it('places first-person view at visor height and looks through the local yaw/pitch', () => {
        const avatarPosition = new Vector3(0, 0.72, 0);
        const pose = planNeonFirstPersonCameraPose({
            avatarPosition,
            cameraYaw: Math.PI / 2,
            cameraPitch: 0.28
        });

        expect(pose.position.y).toBeCloseTo(2.3, 2);
        expect(pose.target.x).toBeGreaterThan(pose.position.x);
        expect(pose.target.y).toBeGreaterThan(pose.position.y);
        expect(pose.fov).toBeGreaterThan(0.9);
    });

    it('frames the complete facility in overview mode', () => {
        const tactical = planNeonTacticalCameraPose({
            snapshot: snapshot(),
            localPlayerId: 'alice',
            selectedRoomId: 'trap',
            aspectRatio: 16 / 9
        });
        const overview = planNeonOverviewCameraPose({ snapshot: snapshot(), aspectRatio: 16 / 9 });

        expect(overview.position.y).toBeGreaterThan(tactical.position.y);
        expect(overview.position.subtract(overview.target).length())
            .toBeGreaterThan(tactical.position.subtract(tactical.target).length());
    });

    it('builds a deterministic entrance-to-exit flyover route and progresses along it', () => {
        const sample = snapshot();
        const firstRoute = neonFlyoverRouteRooms(sample).map((room) => room.id);
        const secondRoute = neonFlyoverRouteRooms(sample).map((room) => room.id);
        const startPose = planNeonFlyoverCameraPose({ snapshot: sample, progress: 0, aspectRatio: 16 / 9 });
        const endPose = planNeonFlyoverCameraPose({ snapshot: sample, progress: 1, aspectRatio: 16 / 9 });

        expect(firstRoute).toEqual(secondRoute);
        expect(firstRoute[0]).toBe('entrance');
        expect(firstRoute).toContain('exit');
        expect(startPose.position.subtract(endPose.position).length()).toBeGreaterThan(1);
    });

    it('documents visual smoke thresholds for the next canvas runtime', () => {
        expect(RELIC_SCENE_NEXT_VISUAL_CONTRACT).toMatchObject({
            minAverageLuma: expect.any(Number),
            maxDarkPixelRatio: expect.any(Number),
            minNeonPixelRatio: expect.any(Number)
        });
        expect(RELIC_SCENE_NEXT_VISUAL_CONTRACT.maxDarkPixelRatio).toBeLessThan(0.7);
    });
});

function snapshot(): RelicPublicSnapshot {
    return {
        protocolVersion: 1,
        gameId: 'game-1',
        roomId: 'room-1',
        phase: 'planning',
        round: 1,
        maxRounds: 10,
        updatedAtEpochMs: 1_700_000_000_000,
        roundTimeLimitMs: 180_000,
        map,
        relics: [],
        roomInvestigations: [],
        players: [{
            playerId: 'alice',
            username: 'Alice',
            characterId: 'kael-ironstride',
            roomId: 'hall',
            health: 3,
            escaped: false,
            defeated: false,
            score: 0,
            relicIds: []
        }],
        submittedPlayerIds: [],
        events: [],
        winnerIds: []
    };
}
