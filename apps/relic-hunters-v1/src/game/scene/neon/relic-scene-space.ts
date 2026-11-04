export const NEON_ROOM_GRID_SCALE = 15.2;

export const ROOM_FLOOR_SIZE = 12.4;

export const ROOM_HALF_ROAM = 5.0;

export const AVATAR_Y = 0.72;

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

export function smoothstep(value: number): number {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
}

export function hashText(value: string): number {
    let hash = 0;
    for (const char of value) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return hash;
}

export function wrapAngle(value: number): number {
    const period = Math.PI * 2;
    return ((value % period) + period) % period;
}
