import { describe, expect, it } from 'vitest';
import {
    AVATAR_PROFILE_SCHEMA_VERSION,
    createAvatarProfileMockProvider,
    createAvatarProfileRequest,
    createDeterministicAvatarProfile,
    validateAvatarProfile
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
        expect(first.version).toBe(AVATAR_PROFILE_SCHEMA_VERSION);
        expect(first.robotFrame).toBeTruthy();
        expect(first.visorExpression).toBeTruthy();
    });

    it('validates bounded cosmetic profiles and rejects gameplay-shaped output', () => {
        const valid = createDeterministicAvatarProfile('session-a', 'Alice');

        expect(validateAvatarProfile(valid, 'session-a')).toEqual({
            ok: true,
            profile: valid
        });

        expect(validateAvatarProfile({
            ...valid,
            healthBonus: 50
        }, 'session-a')).toEqual({
            ok: false,
            reason: 'unexpected-field:healthBonus'
        });

        expect(validateAvatarProfile({
            ...valid,
            glowPalette: 'radioactive-ultraviolet'
        }, 'session-a')).toEqual({
            ok: false,
            reason: 'invalid-glowPalette'
        });
    });

    it('upgrades legacy v1 profiles into bounded robot cosmetics', () => {
        const legacy = {
            schema: 'ar-eye-hunter.avatar-profile',
            version: '1',
            profileId: 'avatar:legacy',
            sessionId: 'session-legacy',
            callsign: 'Legacy Auditor',
            bodyShape: 'sentinel',
            helmet: 'audit-mask',
            armorTrim: 'shoulder-plates',
            glowPalette: 'danger-acid',
            trailStyle: 'scanline',
            decal: 'bug-bounty',
            humourTag: 'morale still pending'
        } as const;

        const validation = validateAvatarProfile(legacy, 'session-legacy');

        expect(validation.ok).toBe(true);
        if (!validation.ok) {
            return;
        }
        expect(validation.profile.version).toBe('2');
        expect(validation.profile.robotFrame).toBe('warden');
        expect(validation.profile.faceplate).toBeTruthy();
    });

    it('creates bounded RallarAI avatar profile requests and accepts provider output', async () => {
        const request = createAvatarProfileRequest({
            sessionId: 'session-ai',
            username: 'Alice',
            roomId: 'room-1',
            revision: 7
        });
        const result = await createAvatarProfileMockProvider().generateJson(request);
        const validation = validateAvatarProfile(result.value, 'session-ai');

        expect(request.prompt).toContain('intimidating neon robot');
        expect(validation.ok).toBe(true);
        if (!validation.ok) {
            return;
        }
        expect(validation.profile.sessionId).toBe('session-ai');
        expect(validation.profile.robotFrame).toBeTruthy();
    });
});
