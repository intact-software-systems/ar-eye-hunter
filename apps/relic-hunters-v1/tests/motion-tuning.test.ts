import { describe, expect, it } from 'vitest';
import {
    RELIC_MOTION_DEFAULT_DELAY_MS,
    RELIC_MOTION_FORCE_SEND_AFTER_MS,
    RELIC_MOTION_IDLE_CADENCE_MS,
    RELIC_MOTION_MAX_DELAY_MS,
    RELIC_MOTION_MAX_EXTRAPOLATION_MS,
    RELIC_MOTION_MIN_DELAY_MS,
    RELIC_MOTION_MIN_POSITION_DELTA,
    RELIC_MOTION_MIN_ROTATION_DELTA,
    RELIC_MOTION_SEND_CADENCE_MS,
    REMOTE_RTC_POSITION_LERP_MS,
    REMOTE_SNAPSHOT_POSITION_LERP_MS,
    ROOM_ROAM_INSPECTION_SPEED_MULTIPLIER,
    ROOM_ROAM_SPRINT_SPEED,
    ROOM_ROAM_WALK_SPEED,
} from '../src/game/scene/motionTuning.ts';

describe('neon adventure motion tuning', () => {
    it('uses visibly faster local roam and sprint speeds', () => {
        expect(ROOM_ROAM_WALK_SPEED).toBe(3.35);
        expect(ROOM_ROAM_SPRINT_SPEED).toBe(5.75);
        expect(ROOM_ROAM_INSPECTION_SPEED_MULTIPLIER).toBe(0.45);
    });

    it('keeps snapshot fallback responsive without making it instant', () => {
        expect(REMOTE_RTC_POSITION_LERP_MS).toBe(22);
        expect(REMOTE_SNAPSHOT_POSITION_LERP_MS).toBe(60);
        expect(REMOTE_RTC_POSITION_LERP_MS).toBeLessThan(REMOTE_SNAPSHOT_POSITION_LERP_MS);
    });

    it('uses low-latency Rallar Motion send and interpolation defaults', () => {
        expect(RELIC_MOTION_SEND_CADENCE_MS).toBe(33);
        expect(RELIC_MOTION_IDLE_CADENCE_MS).toBe(150);
        expect(RELIC_MOTION_FORCE_SEND_AFTER_MS).toBe(180);
        expect(RELIC_MOTION_MIN_POSITION_DELTA).toBe(0.025);
        expect(RELIC_MOTION_MIN_ROTATION_DELTA).toBe(0.035);
        expect(RELIC_MOTION_DEFAULT_DELAY_MS).toBe(75);
        expect(RELIC_MOTION_MIN_DELAY_MS).toBe(45);
        expect(RELIC_MOTION_MAX_DELAY_MS).toBe(140);
        expect(RELIC_MOTION_MAX_EXTRAPOLATION_MS).toBe(150);
    });
});
