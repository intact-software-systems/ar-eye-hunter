import { describe, expect, it } from 'vitest';

import {
    ARENA_AUDIO_STORAGE_KEY,
    calculateArenaAudioEffectiveLevels,
    createDefaultArenaAudioSettings,
    normalizeArenaAudioSettings,
    shouldPlayArenaAudioVoice,
} from '../../../apps/ar-eye-hunter-v1/src/game/arenaAudio.ts';

describe('AR Eye Hunter arena audio', () => {
    it('keeps defaults audible but restrained', () => {
        const settings = createDefaultArenaAudioSettings();
        const levels = calculateArenaAudioEffectiveLevels(settings);

        expect(settings.masterVolume).toBeGreaterThanOrEqual(0.28);
        expect(settings.masterVolume).toBeLessThanOrEqual(0.42);
        expect(settings.musicVolume).toBeGreaterThanOrEqual(0.18);
        expect(settings.sfxVolume).toBeGreaterThanOrEqual(0.45);
        expect(settings.eyeDroneVolume).toBeGreaterThanOrEqual(0.12);
        expect(levels.music).toBeGreaterThanOrEqual(0.003);
        expect(levels.shot).toBeGreaterThanOrEqual(0.08);
        expect(levels.eyeDrone).toBeGreaterThanOrEqual(0.001);
        expect(levels.music).toBeLessThan(0.02);
        expect(levels.shot).toBeLessThan(0.28);
        expect(levels.eyeDrone).toBeLessThan(0.01);
        expect(settings.muted).toBe(false);
        expect(ARENA_AUDIO_STORAGE_KEY).toBe('ar-eye-hunter.audio.v2');
    });

    it('normalizes persisted settings and disables voices while muted', () => {
        const settings = normalizeArenaAudioSettings({
            masterVolume: 4,
            musicVolume: -1,
            sfxVolume: 2,
            eyeDroneVolume: 9,
            muted: true,
            reducedIntensity: true,
        });

        expect(settings.masterVolume).toBe(1);
        expect(settings.musicVolume).toBe(0);
        expect(settings.sfxVolume).toBe(1);
        expect(settings.eyeDroneVolume).toBe(1);
        expect(settings.reducedIntensity).toBe(true);
        expect(shouldPlayArenaAudioVoice(settings, 0, 8)).toBe(false);
    });

    it('caps simultaneous procedural voices', () => {
        const settings = createDefaultArenaAudioSettings();

        expect(shouldPlayArenaAudioVoice(settings, 7, 8)).toBe(true);
        expect(shouldPlayArenaAudioVoice(settings, 8, 8)).toBe(false);
    });
});
