import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { POINTER_LOOK_SENSITIVITY } from './constants.ts';

export type LookState = Readonly<{
    cameraYaw: { value: number; };
    cameraPitch: { value: number; };
}>;

export function applyPointerLook(
    state: LookState,
    movementX: number,
    movementY: number
): void {
    state.cameraYaw.value += movementX * POINTER_LOOK_SENSITIVITY;
    state.cameraPitch.value = clamp(
        state.cameraPitch.value - movementY * POINTER_LOOK_SENSITIVITY,
        -0.66,
        0.58
    );
}

export function yawToForward(yaw: number): Vector3 {
    return new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
}

export function isRoamKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return normalized === 'w' ||
        normalized === 'a' ||
        normalized === 's' ||
        normalized === 'd' ||
        normalized === 'q' ||
        normalized === 'e' ||
        normalized === 'shift' ||
        normalized === 'arrowup' ||
        normalized === 'arrowdown' ||
        normalized === 'arrowleft' ||
        normalized === 'arrowright';
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
