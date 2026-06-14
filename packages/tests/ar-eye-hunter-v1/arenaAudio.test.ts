import { describe, expect, it } from 'vitest';

import {
    createDefaultArenaAudioSettings,
    normalizeArenaAudioSettings,
    shouldPlayArenaAudioVoice,
} from '../../../apps/ar-eye-hunter-v1/src/game/arenaAudio.ts';

describe('AR Eye Hunter arena audio', () => {
    it('keeps eerie score and eye drone quiet by default', () => {
        const settings = createDefaultArenaAudioSettings();

        expect(settings.masterVolume).toBeLessThanOrEqual(0.22);
        expect(settings.musicVolume).toBeLessThanOrEqual(0.12);
        expect(settings.eyeDroneVolume).toBeLessThanOrEqual(0.08);
        expect(settings.muted).toBe(false);
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
