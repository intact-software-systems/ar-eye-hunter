import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Vec3Tuple } from '../types.ts';

export function hashString(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    }
    return hash;
}

export function forwardFromAngles(yaw: number, pitch: number): Vec3Tuple {
    const cosPitch = Math.cos(pitch);
    return [
        Math.sin(yaw) * cosPitch,
        -Math.sin(pitch),
        Math.cos(yaw) * cosPitch
    ];
}

export function vector3(tuple: Vec3Tuple): Vector3 {
    return new Vector3(tuple[0], tuple[1], tuple[2]);
}

export function addTuple(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subTuple(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scaleTuple(a: Vec3Tuple, scalar: number): Vec3Tuple {
    return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

export function dotTuple(a: Vec3Tuple, b: Vec3Tuple): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function distanceTuple(a: Vec3Tuple, b: Vec3Tuple): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function normalizeTuple(value: Vec3Tuple): Vec3Tuple {
    const length = Math.hypot(value[0], value[1], value[2]);
    return length > 0.0001
        ? [value[0] / length, value[1] / length, value[2] / length]
        : [0, 0, 1];
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
