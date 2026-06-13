import { describe, expect, it } from 'vitest';
import {
    createDeterministicAvatarProfile,
    validateAvatarProfile,
} from '../../../apps/ar-eye-hunter-v1/src/game/avatarProfile.ts';

describe('AR Eye Hunter avatar profiles', () => {
    it('creates stable but varied deterministic cosmetic profiles', () => {
        const first = createDeterministicAvatarProfile('session-a', 'Alice');
        const again = createDeterministicAvatarProfile('session-a', 'Alice');
        const second = createDeterministicAvatarProfile('session-b', 'Bob');

        expect(first).toEqual(again);
        expect(first.profileId).not.toBe(second.profileId);
        expect(first.sessionId).toBe('session-a');
        expect(first.callsign.length).toBeGreaterThan(0);
    });

    it('validates bounded cosmetic profiles and rejects gameplay-shaped output', () => {
        const valid = createDeterministicAvatarProfile('session-a', 'Alice');

        expect(validateAvatarProfile(valid, 'session-a')).toEqual({
            ok: true,
            profile: valid,
        });

        expect(validateAvatarProfile({
            ...valid,
            healthBonus: 50,
        }, 'session-a')).toEqual({
            ok: false,
            reason: 'unexpected-field:healthBonus',
        });

        expect(validateAvatarProfile({
            ...valid,
            glowPalette: 'radioactive-ultraviolet',
        }, 'session-a')).toEqual({
            ok: false,
            reason: 'invalid-glowPalette',
        });
    });
});
