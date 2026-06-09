import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';

export type RelicLightingPresetId = 'day' | 'sunset' | 'night' | 'lantern';

export type RelicLightingPreset = Readonly<{
    id: RelicLightingPresetId;
    clearColor: string;
    fogColor: string;
    fogDensity: number;
    ambientColor: string;
    environmentIntensity: number;
    sunDirection: readonly [number, number, number];
    sunPosition: readonly [number, number, number];
    sunIntensity: number;
    sunDiffuse: string;
    sunSpecular: string;
    hemiDirection: readonly [number, number, number];
    hemiIntensity: number;
    hemiDiffuse: string;
    hemiGround: string;
    shadowDarkness: number;
    shadowBlurKernel: number;
    roomLightMultiplier: number;
    postProcess: Readonly<{
        exposure: number;
        contrast: number;
        vignetteWeight: number;
        bloomWeight: number;
        grainIntensity: number;
    }>;
}>;

export const RELIC_LIGHTING_PRESETS: Readonly<Record<RelicLightingPresetId, RelicLightingPreset>> = {
    day: {
        id: 'day',
        clearColor: '#dff9ff',
        fogColor: '#bff6ff',
        fogDensity: 0.0010,
        ambientColor: '#e7fbff',
        environmentIntensity: 1.22,
        sunDirection: [-0.52, -1.28, -0.42],
        sunPosition: [30, 54, 25],
        sunIntensity: 3.25,
        sunDiffuse: '#f7fdff',
        sunSpecular: '#ffffff',
        hemiDirection: [0.10, 1, 0.18],
        hemiIntensity: 1.48,
        hemiDiffuse: '#effdff',
        hemiGround: '#5eead4',
        shadowDarkness: 0.05,
        shadowBlurKernel: 3,
        roomLightMultiplier: 1.20,
        postProcess: {
            exposure: 1.46,
            contrast: 1.00,
            vignetteWeight: 0.03,
            bloomWeight: 0.42,
            grainIntensity: 0.02,
        },
    },
    sunset: {
        id: 'sunset',
        clearColor: '#f5e8ff',
        fogColor: '#e9d5ff',
        fogDensity: 0.0012,
        ambientColor: '#f8e9ff',
        environmentIntensity: 1.16,
        sunDirection: [-0.78, -0.82, -0.34],
        sunPosition: [38, 34, 22],
        sunIntensity: 2.88,
        sunDiffuse: '#ffe8ff',
        sunSpecular: '#ffffff',
        hemiDirection: [0.06, 1, 0.22],
        hemiIntensity: 1.36,
        hemiDiffuse: '#fff5ff',
        hemiGround: '#7c3aed',
        shadowDarkness: 0.06,
        shadowBlurKernel: 4,
        roomLightMultiplier: 1.22,
        postProcess: {
            exposure: 1.42,
            contrast: 1.00,
            vignetteWeight: 0.04,
            bloomWeight: 0.46,
            grainIntensity: 0.02,
        },
    },
    night: {
        id: 'night',
        clearColor: '#c7f4ff',
        fogColor: '#bdefff',
        fogDensity: 0.0013,
        ambientColor: '#dbeafe',
        environmentIntensity: 1.12,
        sunDirection: [-0.36, -0.74, -0.58],
        sunPosition: [22, 32, 32],
        sunIntensity: 2.64,
        sunDiffuse: '#dbeafe',
        sunSpecular: '#ffffff',
        hemiDirection: [0.10, 1, 0.30],
        hemiIntensity: 1.34,
        hemiDiffuse: '#e0f2fe',
        hemiGround: '#2563eb',
        shadowDarkness: 0.07,
        shadowBlurKernel: 4,
        roomLightMultiplier: 1.32,
        postProcess: {
            exposure: 1.40,
            contrast: 1.01,
            vignetteWeight: 0.04,
            bloomWeight: 0.48,
            grainIntensity: 0.02,
        },
    },
    lantern: {
        id: 'lantern',
        clearColor: '#e6fbff',
        fogColor: '#c7f7ff',
        fogDensity: 0.0011,
        ambientColor: '#f1fbff',
        environmentIntensity: 1.18,
        sunDirection: [-0.44, -0.94, -0.50],
        sunPosition: [26, 40, 28],
        sunIntensity: 2.92,
        sunDiffuse: '#e0ffff',
        sunSpecular: '#ffffff',
        hemiDirection: [0.08, 1, 0.22],
        hemiIntensity: 1.42,
        hemiDiffuse: '#f0fdff',
        hemiGround: '#0f766e',
        shadowDarkness: 0.06,
        shadowBlurKernel: 4,
        roomLightMultiplier: 1.28,
        postProcess: {
            exposure: 1.44,
            contrast: 1.00,
            vignetteWeight: 0.03,
            bloomWeight: 0.46,
            grainIntensity: 0.02,
        },
    },
};

export const RELIC_ROOM_LIGHTING_PRESETS: Readonly<Record<RelicRoom['kind'], RelicLightingPresetId>> = {
    entrance: 'day',
    hallway: 'lantern',
    storage: 'lantern',
    shrine: 'lantern',
    trap: 'lantern',
    treasure: 'lantern',
    monster: 'lantern',
    exit: 'sunset',
};

export function selectRelicLightingPreset({
    snapshot,
    currentRoom,
}: Readonly<{
    snapshot?: RelicPublicSnapshot;
    currentRoom?: RelicRoom;
}>): RelicLightingPreset {
    if (!snapshot || snapshot.phase === 'lobby') {
        return RELIC_LIGHTING_PRESETS.day;
    }
    if (snapshot.phase === 'finished') {
        return RELIC_LIGHTING_PRESETS.sunset;
    }
    if (!currentRoom) {
        return RELIC_LIGHTING_PRESETS.day;
    }
    return RELIC_LIGHTING_PRESETS[RELIC_ROOM_LIGHTING_PRESETS[currentRoom.kind]];
}

export function lightingPresetById(id: RelicLightingPresetId): RelicLightingPreset {
    return RELIC_LIGHTING_PRESETS[id];
}
