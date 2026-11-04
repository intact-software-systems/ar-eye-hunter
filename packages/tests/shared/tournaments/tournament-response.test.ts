import { decodeTournamentMutationResult } from '@shared/api/tournaments/tournament-mutation-result.ts';
import { decodeTournamentSnapshot } from '@shared/api/tournaments/tournament-snapshot.ts';
import { describe, expect, it } from 'vitest';

const ref = { applicationId: 'game', workspaceId: 'default', tournamentId: 'cup' };

describe('tournament public response boundaries', () => {
    it('requires an exact scoped receipt with consistent refusal status', () => {
        const receipt = { ref, requestId: 'request', status: 'applied', code: null };
        expect(decodeTournamentMutationResult(receipt, receipt)).toEqual(receipt);
        for (
            const invalid of [{ ...receipt, ref: { ...ref, applicationId: 'other' } }, { ...receipt, requestId: 'other' }, { ...receipt, code: 'denied' }, {
                ...receipt,
                status: 'refused'
            }, { ...receipt, actor: 'private' }]
        ) {
            expect(() => decodeTournamentMutationResult(invalid, receipt)).toThrow();
        }
    });
    it('accepts an absent tournament but rejects private consent fields in public snapshots', () => {
        const snapshot = { ref, principalId: 'alice', observedAtEpochMs: 1000, tournament: null, listing: 'unlisted' };
        expect(decodeTournamentSnapshot(snapshot)).toEqual(snapshot);
        expect(() => decodeTournamentSnapshot({ ...snapshot, checkIns: [] })).toThrow();
        expect(() => decodeTournamentSnapshot({ ...snapshot, principalId: '' })).toThrow();
        expect(() => decodeTournamentSnapshot({ ...snapshot, listing: undefined })).toThrow();
        expect(() => decodeTournamentSnapshot({ ...snapshot, listing: 'secret' })).toThrow();
    });
});
