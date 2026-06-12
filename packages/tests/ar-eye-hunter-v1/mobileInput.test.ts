import { describe, expect, it } from 'vitest';

import {
    calculateVirtualStick,
    createDefaultMobileControlSettings,
    createInitialTouchControlState,
    loadMobileControlSettings,
    mapTouchLookDelta,
    resetTouchPointer,
    shouldFireHeldWeapon,
    updateTouchPointer,
} from '../../../apps/ar-eye-hunter-v1/src/game/mobileInput.ts';

describe('AR Eye Hunter mobile input', () => {
    it('maps virtual stick movement with deadzone, clamp, and sprint threshold', () => {
        const idle = calculateVirtualStick({ x: 100, y: 100 }, { x: 103, y: 101 }, 72);
        expect(idle.moveX).toBe(0);
        expect(idle.moveZ).toBe(0);
        expect(idle.sprint).toBe(false);

        const moving = calculateVirtualStick({ x: 100, y: 100 }, { x: 190, y: 28 }, 72);
        expect(moving.moveX).toBeCloseTo(0.78, 1);
        expect(moving.moveZ).toBeCloseTo(0.63, 1);
        expect(moving.knobX).toBeLessThanOrEqual(72);
        expect(moving.knobY).toBeLessThanOrEqual(72);
        expect(moving.sprint).toBe(true);
    });

    it('tracks independent move/look pointers and resets them on cancel', () => {
        let state = createInitialTouchControlState();
        state = updateTouchPointer(state, 'move', 11, { x: 48, y: 80 });
        state = updateTouchPointer(state, 'look', 22, { x: 420, y: 130 });

        expect(state.movePointerId).toBe(11);
        expect(state.lookPointerId).toBe(22);
        expect(state.lastInputMode).toBe('touch');

        state = resetTouchPointer(state, 11);
        expect(state.movePointerId).toBeUndefined();
        expect(state.lookPointerId).toBe(22);

        state = resetTouchPointer(state, 22);
        expect(state.lookPointerId).toBeUndefined();
        expect(state.lookActive).toBe(false);
    });

    it('maps touch look deltas through sensitivity and invert-y settings', () => {
        const normal = mapTouchLookDelta(20, -10, {
            ...createDefaultMobileControlSettings(),
            touchSensitivity: 1.5,
            invertY: false,
        });
        expect(normal.yawDelta).toBeCloseTo(0.081, 3);
        expect(normal.pitchDelta).toBeCloseTo(-0.034, 3);

        const inverted = mapTouchLookDelta(20, -10, {
            ...createDefaultMobileControlSettings(),
            touchSensitivity: 1.5,
            invertY: true,
        });
        expect(inverted.pitchDelta).toBeCloseTo(0.034, 3);
    });

    it('gates held fire by weapon readiness without changing ammo state', () => {
        expect(shouldFireHeldWeapon(true, 1_000, 900)).toBe(true);
        expect(shouldFireHeldWeapon(true, 1_000, 1_200)).toBe(false);
        expect(shouldFireHeldWeapon(false, 1_000, 900)).toBe(false);
    });

    it('loads mobile settings with safe defaults and clamped persisted values', () => {
        const stored = JSON.stringify({
            touchSensitivity: 99,
            invertY: true,
            buttonScale: 0.1,
            gyroEnabled: true,
            hapticsEnabled: false,
        });
        const settings = loadMobileControlSettings(() => stored);

        expect(settings.touchSensitivity).toBe(2.4);
        expect(settings.invertY).toBe(true);
        expect(settings.buttonScale).toBe(0.72);
        expect(settings.gyroEnabled).toBe(true);
        expect(settings.hapticsEnabled).toBe(false);

        const fallback = loadMobileControlSettings(() => 'not json');
        expect(fallback).toEqual(createDefaultMobileControlSettings());
    });
});
