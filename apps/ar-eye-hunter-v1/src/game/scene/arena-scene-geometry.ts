import type { Vec3Tuple } from '@ar-eye-hunter/arena-contracts.ts';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';

export function hashString(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    }
    return hash;
}

export function vector3(tuple: Vec3Tuple): Vector3 {
    return new Vector3(tuple[0], tuple[1], tuple[2]);
}

export function normalizeTuple(value: Vec3Tuple): Vec3Tuple {
    const length = Math.hypot(value[0], value[1], value[2]);
    return length > 0.0001
        ? [value[0] / length, value[1] / length, value[2] / length]
        : [0, 0, 1];
}
