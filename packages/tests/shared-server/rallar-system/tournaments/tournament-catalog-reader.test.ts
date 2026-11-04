import { TournamentCatalogCursor } from '@shared-server/rallar-system/tournaments/catalog/tournament-catalog-cursor.ts';
import { TournamentCatalogReader } from '@shared-server/rallar-system/tournaments/catalog/tournament-catalog-reader.ts';
import { TOURNAMENT_PUBLICATIONS_NAMESPACE } from '@shared-server/rallar-system/tournaments/tournament-publication.ts';
import { TOURNAMENTS_NAMESPACE } from '@shared-server/rallar-system/tournaments/tournament-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { Tournament } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { computeTournament, createTournament } from '@shared/tournaments/compute-tournament.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const request = { scope, principalId: 'alice', view: 'public' as const, limit: 20, cursor: null };

function bracket(id: string): Tournament {
    return createTournament({
        ref: { ...scope, tournamentId: id },
        title: id,
        organizerPrincipalId: 'host',
        rulesId: 'native',
        createdAtEpochMs: 1,
        noShowGraceMs: 600000
    });
}

describe('bounded tournament discovery and personal history', () => {
    let runtime: PSqlRuntimeStateRepository;
    let reader: TournamentCatalogReader;
    beforeEach(async () => {
        const storage = await createResourceInboxTestStorage('tournament_catalog', 4);
        runtime = new PSqlRuntimeStateRepository(storage.sql);
        reader = new TournamentCatalogReader(runtime, () => 1000, new TournamentCatalogCursor('test-only-catalogue-key'));
        return () => storage.close();
    });

    async function seed(tournament: Tournament, listing: 'listed' | 'unlisted' | null = null) {
        const key = `app=${encodeURIComponent(tournament.ref.applicationId)}:ws=${encodeURIComponent(tournament.ref.workspaceId)}:tournament=${
            encodeURIComponent(tournament.ref.tournamentId)
        }`;
        await runtime.upsert(TOURNAMENTS_NAMESPACE, key, JSON.stringify({ tournament, checkIns: [] }), NEVER_EXPIRE_AT_TIMESTAMP);
        if (listing !== null) {
            await runtime.upsert(TOURNAMENT_PUBLICATIONS_NAMESPACE, key, JSON.stringify({ ref: tournament.ref, listing }), NEVER_EXPIRE_AT_TIMESTAMP);
        }
    }

    it('returns an empty catalogue when no brackets exist', async () => {
        expect(await reader.read(request)).toEqual({ scope, principalId: 'alice', view: 'public', observedAtEpochMs: 1000, entries: [], nextCursor: null });
    });

    it('lists only published live brackets in the exact game and workspace without private fields', async () => {
        await seed(bracket('hidden'));
        await seed(bracket('unlisted'), 'unlisted');
        await seed({ ...bracket('cancelled'), status: 'cancelled' }, 'listed');
        await seed({ ...bracket('elsewhere'), ref: { ...scope, applicationId: 'other', tournamentId: 'elsewhere' } }, 'listed');
        await seed(bracket('visible'), 'listed');
        expect(await reader.read(request)).toEqual({
            scope,
            principalId: 'alice',
            view: 'public',
            observedAtEpochMs: 1000,
            nextCursor: null,
            entries: [{
                ref: { ...scope, tournamentId: 'visible' },
                title: 'visible',
                organizerPrincipalId: 'host',
                status: 'registration',
                activeEntrantCount: 0,
                nextScheduledAtEpochMs: null
            }]
        });
    });

    it('retains organizer and withdrawn entrant history privately even when unlisted or cancelled', async () => {
        await seed({ ...bracket('organized'), organizerPrincipalId: 'alice' });
        let withdrawn = bracket('withdrawn');
        for (const principalId of ['alice', 'bob', 'charlie', 'dana']) {
            withdrawn = computeTournament({ state: withdrawn, command: { type: 'register' }, actorPrincipalId: principalId, nowEpochMs: 1, results: [] }).state;
        }
        withdrawn = computeTournament({ state: withdrawn, command: { type: 'launch' }, actorPrincipalId: 'host', nowEpochMs: 2, results: [] }).state;
        withdrawn = computeTournament({ state: withdrawn, command: { type: 'withdraw' }, actorPrincipalId: 'alice', nowEpochMs: 3, results: [] }).state;
        withdrawn = computeTournament({ state: withdrawn, command: { type: 'cancel' }, actorPrincipalId: 'host', nowEpochMs: 4, results: [] }).state;
        await seed(withdrawn);
        await seed(bracket('stranger'), 'listed');
        expect((await reader.read({ ...request, view: 'mine' })).entries.map((entry) => entry.title)).toEqual(['organized', 'withdrawn']);
        expect((await reader.read({ ...request, view: 'mine', principalId: 'outsider' })).entries).toEqual([]);
    });

    it('removes pre-launch withdrawals from personal history without removing the organizer history', async () => {
        let tournament = bracket('withdraw-before-launch');
        tournament = computeTournament({ state: tournament, command: { type: 'register' }, actorPrincipalId: 'alice', nowEpochMs: 1, results: [] }).state;
        await seed(tournament);
        expect((await reader.read({ ...request, view: 'mine' })).entries.map((entry) => entry.title)).toEqual(['withdraw-before-launch']);
        tournament = computeTournament({ state: tournament, command: { type: 'withdraw' }, actorPrincipalId: 'alice', nowEpochMs: 2, results: [] }).state;
        await seed(tournament);
        expect((await reader.read({ ...request, view: 'mine' })).entries).toEqual([]);
        expect((await reader.read({ ...request, view: 'mine', principalId: 'host' })).entries.map((entry) => entry.title)).toEqual(['withdraw-before-launch']);
    });

    it('returns a continuation for a sparse empty page without scanning until it fills', async () => {
        for (let index = 0; index < 201; index++) {
            await seed({ ...bracket(String(index).padStart(3, '0')), organizerPrincipalId: index === 200 ? 'alice' : 'host' });
        }
        const first = await reader.read({ ...request, view: 'mine' });
        expect(first.entries).toEqual([]);
        expect(first.nextCursor).not.toBeNull();
        expect(
            () => JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')),
            'a sparse continuation must not disclose the filtered storage key'
        ).toThrow();
        const last = await reader.read({ ...request, view: 'mine', cursor: first.nextCursor });
        expect(last.entries.map((entry) => entry.title)).toEqual(['200']);
        expect(last.nextCursor).toBeNull();
        await expect(reader.read({ ...request, view: 'mine', principalId: 'bob', cursor: first.nextCursor })).rejects.toThrow();
        await expect(reader.read({ ...request, cursor: first.nextCursor })).rejects.toThrow();
        await expect(reader.read({ ...request, view: 'mine', scope: { ...scope, workspaceId: 'other' }, cursor: first.nextCursor })).rejects.toThrow();
    });

    it('continues after the last displayed entry without dropping the rest of a scanned page', async () => {
        for (const id of ['a', 'b', 'c']) {
            await seed(bracket(id), 'listed');
        }
        const first = await reader.read({ ...request, limit: 1 });
        const second = await reader.read({ ...request, limit: 1, cursor: first.nextCursor });
        const third = await reader.read({ ...request, limit: 1, cursor: second.nextCursor });
        expect([first, second, third].flatMap((page) => page.entries.map((entry) => entry.title))).toEqual(['a', 'b', 'c']);
        expect(third.nextCursor).toBeNull();
        await expect(reader.read({ ...request, limit: 51 })).rejects.toThrow();
    });

    it('fails closed on corrupt bracket and publication slots rather than hiding them as unlisted', async () => {
        await runtime.upsert(
            TOURNAMENTS_NAMESPACE,
            'app=game:ws=default:tournament=wrong',
            JSON.stringify({ tournament: bracket('actual'), checkIns: [] }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        await expect(reader.read(request)).rejects.toThrow();
        await runtime.deleteByKey(TOURNAMENTS_NAMESPACE, 'app=game:ws=default:tournament=wrong');
        await seed(bracket('actual'));
        await runtime.upsert(
            TOURNAMENT_PUBLICATIONS_NAMESPACE,
            'app=game:ws=default:tournament=actual',
            JSON.stringify({ ref: { ...scope, tournamentId: 'wrong' }, listing: 'listed' }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
        await expect(reader.read(request)).rejects.toThrow();
    });
});
