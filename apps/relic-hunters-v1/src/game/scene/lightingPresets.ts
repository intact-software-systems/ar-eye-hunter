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
        clearColor: '#dfefff',
        fogColor: '#d8e9f5',
        fogDensity: 0.0028,
        ambientColor: '#c9d5ee',
        environmentIntensity: 0.72,
        sunDirection: [-0.52, -1.28, -0.42],
        sunPosition: [30, 54, 25],
        sunIntensity: 2.45,
        sunDiffuse: '#fff1d3',
        sunSpecular: '#fff8ea',
        hemiDirection: [0.10, 1, 0.18],
        hemiIntensity: 0.96,
        hemiDiffuse: '#edf3ff',
        hemiGround: '#7a6a58',
        shadowDarkness: 0.22,
        shadowBlurKernel: 3,
        roomLightMultiplier: 0.86,
        postProcess: {
            exposure: 1.16,
            contrast: 1.10,
            vignetteWeight: 0.55,
            bloomWeight: 0.18,
            grainIntensity: 0.55,
        },
    },
    sunset: {
        id: 'sunset',
        clearColor: '#f1d6bc',
        fogColor: '#d7c5bb',
        fogDensity: 0.0034,
        ambientColor: '#c6bddc',
        environmentIntensity: 0.66,
        sunDirection: [-0.78, -0.82, -0.34],
        sunPosition: [38, 34, 22],
        sunIntensity: 2.10,
        sunDiffuse: '#ffd094',
        sunSpecular: '#fff2cf',
        hemiDirection: [0.06, 1, 0.22],
        hemiIntensity: 0.86,
        hemiDiffuse: '#dfe8ff',
        hemiGround: '#78513d',
        shadowDarkness: 0.25,
        shadowBlurKernel: 4,
        roomLightMultiplier: 0.96,
        postProcess: {
            exposure: 1.18,
            contrast: 1.13,
            vignetteWeight: 0.70,
            bloomWeight: 0.24,
            grainIntensity: 0.75,
        },
    },
    night: {
        id: 'night',
        clearColor: '#111827',
        fogColor: '#1c2436',
        fogDensity: 0.0058,
        ambientColor: '#7d86b3',
        environmentIntensity: 0.48,
        sunDirection: [-0.36, -0.74, -0.58],
        sunPosition: [22, 32, 32],
        sunIntensity: 1.05,
        sunDiffuse: '#9fb8ff',
        sunSpecular: '#dbe7ff',
        hemiDirection: [0.10, 1, 0.30],
        hemiIntensity: 0.76,
        hemiDiffuse: '#bac8ff',
        hemiGround: '#2d2630',
        shadowDarkness: 0.32,
        shadowBlurKernel: 4,
        roomLightMultiplier: 1.22,
        postProcess: {
            exposure: 1.16,
            contrast: 1.22,
            vignetteWeight: 1.05,
            bloomWeight: 0.32,
            grainIntensity: 1.10,
        },
    },
    lantern: {
        id: 'lantern',
        clearColor: '#202631',
        fogColor: '#252a37',
        fogDensity: 0.0048,
        ambientColor: '#a49ab2',
        environmentIntensity: 0.54,
        sunDirection: [-0.44, -0.94, -0.50],
        sunPosition: [26, 40, 28],
        sunIntensity: 1.38,
        sunDiffuse: '#ffd7a3',
        sunSpecular: '#fff0d6',
        hemiDirection: [0.08, 1, 0.22],
        hemiIntensity: 0.78,
        hemiDiffuse: '#d8dcff',
        hemiGround: '#4f3426',
        shadowDarkness: 0.28,
        shadowBlurKernel: 4,
        roomLightMultiplier: 1.18,
        postProcess: {
            exposure: 1.20,
            contrast: 1.14,
            vignetteWeight: 0.82,
            bloomWeight: 0.29,
            grainIntensity: 0.86,
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
    monster: 'night',
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
