export type WorldMapCoordinate = Readonly<{
    latitude: number;
    longitude: number;
}>;

export type WorldMapPoint = Readonly<{
    x: number;
    y: number;
}>;

export const WORLD_MAP_VIEWBOX = {
    width: 1000,
    height: 520,
} as const;

export function projectWorldCoordinate(
    coordinate: WorldMapCoordinate,
    viewBox: Readonly<{ width: number; height: number }> = WORLD_MAP_VIEWBOX,
): WorldMapPoint {
    const latitude = clamp(coordinate.latitude, -90, 90);
    const longitude = clamp(coordinate.longitude, -180, 180);
    return {
        x: ((longitude + 180) / 360) * viewBox.width,
        y: ((90 - latitude) / 180) * viewBox.height,
    };
}

export function worldMapArcPath(
    source: WorldMapPoint,
    target: WorldMapPoint,
): string {
    const midX = (source.x + target.x) / 2;
    const midY = (source.y + target.y) / 2;
    const distance = Math.hypot(target.x - source.x, target.y - source.y);
    const lift = clamp(distance * 0.18, 28, 96);
    const controlY = Math.max(18, midY - lift);
    return `M ${round(source.x)} ${round(source.y)} Q ${round(midX)} ${round(controlY)} ${round(target.x)} ${round(target.y)}`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
    return Math.round(value * 10) / 10;
}
