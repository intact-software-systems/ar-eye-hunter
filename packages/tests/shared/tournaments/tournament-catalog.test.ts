import { decodeTournamentCatalogPage } from '@shared/api/tournaments/tournament-catalog.ts';
import { describe, expect, it } from 'vitest';

const scope = { applicationId: 'game', workspaceId: 'default' };
const entry = {
    ref: { ...scope, tournamentId: 'cup' },
    title: 'Friday cup',
    organizerPrincipalId: 'alice',
    status: 'registration',
    activeEntrantCount: 1,
    nextScheduledAtEpochMs: null
};
const page = { scope, principalId: 'bob', view: 'public', observedAtEpochMs: 1, entries: [entry], nextCursor: null };

describe('tournament catalogue wire boundary', () => {
    it('accepts exact public cards and sparse pages with a continuation', () => {
        expect(decodeTournamentCatalogPage(page)).toEqual(page);
        expect(decodeTournamentCatalogPage({ ...page, entries: [], nextCursor: 'next' })).toMatchObject({ entries: [], nextCursor: 'next' });
    });
    it.each([
        { ...entry, sessionId: 'private' },
        { ...entry, checkIns: [] },
        { ...entry, roomRef: { ...scope, groupId: 'private' } },
        { ...entry, activeEntrantCount: 5 },
        { ...entry, ref: { ...entry.ref, workspaceId: 'other' } },
        { ...entry, status: 'unexpected' }
    ])('rejects private fields and invalid projections', (invalid) => {
        expect(() => decodeTournamentCatalogPage({ ...page, entries: [invalid] })).toThrow();
    });
    it('rejects duplicate cards and oversized pages', () => {
        expect(() => decodeTournamentCatalogPage({ ...page, entries: [entry, entry] })).toThrow();
        expect(() =>
            decodeTournamentCatalogPage({
                ...page,
                entries: Array.from({ length: 51 }, (_, i) => ({ ...entry, ref: { ...entry.ref, tournamentId: String(i) } }))
            })
        ).toThrow();
    });
});
