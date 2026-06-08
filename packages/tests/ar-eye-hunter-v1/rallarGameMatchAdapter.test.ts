import { describe, expect, it } from 'vitest';

import {
    ARENA_RALLAR_GAME_DATA_CHANNEL_LANES,
    ARENA_RALLAR_GAME_LANE_IDS,
    GAME_SNAPSHOT_LANE_ID,
    isArenaAcceptedShotFromSender,
    isArenaPoseIntentFromSender,
    isArenaShotIntentFromSender,
} from '../../../apps/ar-eye-hunter-v1/src/game/rallar-game-match-adapter.ts';
import type {
    GameRealtimeMessage,
    PlayerPose,
    ShotIntent,
} from '../../../apps/ar-eye-hunter-v1/src/game/types.ts';

describe('AR Eye Hunter Rallar Game match adapter', () => {
    it('maps AR lanes into the generic Rallar Game lane model', () => {
        expect(ARENA_RALLAR_GAME_LANE_IDS).toEqual({
            input: 'motion',
            intent: 'combat',
            snapshot: GAME_SNAPSHOT_LANE_ID,
            metrics: 'fx',
            replication: 'ai-events',
        });
        expect(ARENA_RALLAR_GAME_DATA_CHANNEL_LANES.map((lane) => lane.id))
            .toContain(GAME_SNAPSHOT_LANE_ID);
    });

    it('accepts pose and shot intents only from the sender peer', () => {
        const pose = playerPose('peer-a');
        const poseIntent: GameRealtimeMessage = {
            protocol: 'ar-eye-hunter.v1',
            kind: 'player-pose-intent',
            pose,
        };
        const shotIntent: GameRealtimeMessage = {
            protocol: 'ar-eye-hunter.v1',
            kind: 'player-shot-intent',
            shot: shot('peer-a'),
        };
        const acceptedShot: GameRealtimeMessage = {
            protocol: 'ar-eye-hunter.v1',
            kind: 'director-shot-accepted',
            accepted: {
                shot: shot('peer-a'),
                hit: true,
                targetId: 'eye-1',
                impact: [0, 2, 4],
                scoreDelta: 120,
                combo: 2,
                multiplier: 1,
                overdrive: 20,
                revision: 3,
                acceptedAtEpochMs: 1_000,
            },
        };

        expect(isArenaPoseIntentFromSender(poseIntent, 'peer-a')).toBe(true);
        expect(isArenaPoseIntentFromSender(poseIntent, 'peer-b')).toBe(false);
        expect(isArenaShotIntentFromSender(shotIntent, 'peer-a')).toBe(true);
        expect(isArenaShotIntentFromSender(shotIntent, 'peer-b')).toBe(false);
        expect(isArenaAcceptedShotFromSender(acceptedShot, 'peer-a')).toBe(true);
        expect(isArenaAcceptedShotFromSender(acceptedShot, 'peer-b')).toBe(false);
    });
});

function playerPose(sessionId: string): PlayerPose {
    return {
        sessionId,
        username: sessionId,
        color: '#00c2a8',
        position: [0, 2, 0],
        rotation: [0, 0, 0],
        score: 0,
        seq: 1,
        sentAtEpochMs: 1_000,
    };
}

function shot(sessionId: string): ShotIntent {
    return {
        sessionId,
        username: sessionId,
        color: '#00c2a8',
        origin: [0, 2, 0],
        direction: [0, 0, 1],
        seq: 1,
        sentAtEpochMs: 1_000,
    };
}
