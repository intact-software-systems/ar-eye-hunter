import {
    bindTournamentGameProfile,
    decodeTournamentGameProfiles
} from '@shared-server/rallar-system/tournaments/tournament-game-profile.ts';
import { describe, expect, it } from 'vitest';

const owner = {
    scope: { applicationId: 'game', workspaceId: 'default' },
    rulesId: 'native-v1',
    gameLifecycleTopic: 'app:game:tournament-start'
};

describe('Tournament game profile ownership', () => {
    it('installs the approved ten-minute default in the game owner only', () => {
        expect(decodeTournamentGameProfiles([])).toEqual([]);
        expect(bindTournamentGameProfile([], owner)).toEqual([{ ...owner, noShowGraceMs: 600000 }]);
    });
    it('preserves an explicit grace period and other scoped owners', () => {
        const configured = { ...owner, noShowGraceMs: 30000 };
        const other = { ...owner, scope: { ...owner.scope, applicationId: 'other' }, noShowGraceMs: 20000 };
        expect(bindTournamentGameProfile([other, configured], owner)).toEqual([other, configured]);
        expect(bindTournamentGameProfile([other], owner)).toEqual([other, { ...owner, noShowGraceMs: 600000 }]);
    });
    it('rejects a profile that names another ruleset or delivery owner', () => {
        for (const change of [{ rulesId: 'wrong-v1' }, { gameLifecycleTopic: 'app:other:tournament-start' }]) {
            expect(() => bindTournamentGameProfile([{ ...owner, noShowGraceMs: 600000, ...change }], owner))
                .toThrow('Tournament profile differs from its native game owner');
        }
    });
    it('rejects duplicate scopes and malformed policies at every boundary', () => {
        const profile = { ...owner, noShowGraceMs: 600000 };
        for (const profiles of [[profile, profile], [{ ...profile, noShowGraceMs: 0 }], [{ ...profile, legacy: true }]]) {
            expect(() => decodeTournamentGameProfiles(profiles)).toThrow();
            expect(() => bindTournamentGameProfile(profiles, owner)).toThrow();
        }
    });
});
