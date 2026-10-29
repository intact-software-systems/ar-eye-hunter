import {
    type Vec3Tuple
} from './arena-contracts.ts';

export function mulberry32(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
        value += 0x6d2b79f5;
        let next = value;
        next = Math.imul(next ^ next >>> 15, next | 1);
        next ^= next + Math.imul(next ^ next >>> 7, next | 61);
        return ((next ^ next >>> 14) >>> 0) / 4294967296;
    };
}

export function hashNumber(value: number): number {
    let hash = value | 0;
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    return hash | 0;
}

export function add3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(value: Vec3Tuple, scalar: number): Vec3Tuple {
    return [value[0] * scalar, value[1] * scalar, value[2] * scalar];
}

export function dot3(a: Vec3Tuple, b: Vec3Tuple): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function distance3(a: Vec3Tuple, b: Vec3Tuple): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function normalize3(value: Vec3Tuple): Vec3Tuple {
    const length = Math.hypot(value[0], value[1], value[2]);
    return length > 0.0001
        ? [value[0] / length, value[1] / length, value[2] / length]
        : [0, 0, 0];
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * clamp(t, 0, 1);
}

export function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

export function roundVec3(value: Vec3Tuple): Vec3Tuple {
    return [
        Math.round(value[0] * 1000) / 1000,
        Math.round(value[1] * 1000) / 1000,
        Math.round(value[2] * 1000) / 1000
    ];
}
