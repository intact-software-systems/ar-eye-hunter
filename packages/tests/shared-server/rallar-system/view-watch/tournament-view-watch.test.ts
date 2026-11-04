import { computeTournamentMutation } from '@shared-server/rallar-system/tournaments/compute-tournament-mutation.ts';
import type { TournamentService } from '@shared-server/rallar-system/tournaments/tournament-service.ts';
import { toTournamentStorageKey } from '@shared-server/rallar-system/tournaments/tournament-storage-key.ts';
import { TOURNAMENT_WATCH_FENCES_NAMESPACE } from '@shared-server/rallar-system/tournaments/tournament-watch-fence.ts';
import { computeViewWatch } from '@shared-server/rallar-system/view-watch/compute-view-watch.ts';
import type { ViewWatchCommand } from '@shared-server/rallar-system/view-watch/view-watch-command.ts';
import { writeViewWatch } from '@shared-server/rallar-system/view-watch/view-watch-service.ts';
import { WS_OUTBOX_PROVENANCE_NAMESPACE } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { decodeViewInvalidationMessage, type ViewInvalidation } from '@shared/api/views/view-invalidation.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { expect, it, vi } from 'vitest';
import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createViewWatchTestRuntime, scope, sessionWatchResource, viewWatchCommand, type ViewWatchTestRuntime } from './view-watch-test-runtime.ts';

const ref = { ...scope, tournamentId: sessionWatchResource.resourceId };
const resource = { ...scope, family: 'tournament' as const, resourceId: ref.tournamentId };

it('keeps tournament and session watch slots independent and creates a watched missing bracket without enrolling its visitor', async () => {
    const storage = await createResourceInboxTestStorage('tournament_absent_watch');
    try {
        const test = await createViewWatchTestRuntime(storage);
        await test.run(viewWatchCommand(test, 'session-watch', null));
        const creation = await prepareCreation(test);
        await test.run(tournamentWatch(test, 'tournament-watch'));
        expect((await test.tournaments.readRecord(ref)).record).toBeNull();
        const fence = await test.tournaments.readWatchFence(ref);
        expect(fence.entry?.expireAtTimestamp).toBe(test.party.sessions.find((session) => session.clientId === 'bob')!.expiresAtEpochMs);
        await expect(storage.sql.begin((transaction) => test.tournamentService.write(transaction, creation))).rejects.toBeInstanceOf(
            RuntimeStateWriteConflictError
        );
        const fresh = await prepareCreation(test);
        await storage.sql.begin((transaction) => test.tournamentService.write(transaction, fresh));
        expect((await test.tournaments.readRecord(ref)).record?.tournament.entrants).toEqual([]);
        expect((await test.repository.listForResource(resource)).map(({ value }) => value.principalId)).toEqual(['bob']);
        expect((await test.repository.listForResource(sessionWatchResource)).map(({ value }) => value.principalId)).toEqual(['bob']);
        expect((await notices(storage)).filter((notice) => notice.principalId === 'bob').map((notice) => notice.resource)).toEqual(['tournament']);
        expect((await test.tournaments.readWatchFence(ref)).entry?.expireAtTimestamp).toBe(NEVER_EXPIRE_AT_TIMESTAMP);
    }
    finally {
        await storage.close();
    }
});

it('renews an absent-resource fence through the current authenticated watcher lifetime without creating a bracket', async () => {
    const storage = await createResourceInboxTestStorage('tournament_fence_renewal');
    try {
        const test = await createViewWatchTestRuntime(storage);
        await seedExpiredFence(test);
        const previous = await test.tournaments.readWatchFence(ref);
        const command = tournamentWatch(test, 'renew-watch');
        await test.run(command);
        const renewed = await test.tournaments.readWatchFence(ref);
        expect(renewed.entry?.revision).toBe(previous.entry!.revision + 1);
        expect(renewed.entry?.expireAtTimestamp).toBe(command.sessionExpiresAtEpochMs);
        expect(renewed.entry?.value).not.toBe(previous.entry!.value);
        expect(renewed.phase).toBe('absent');
        expect((await test.tournaments.readRecord(ref)).record).toBeNull();
    }
    finally {
        await storage.close();
    }
});

it.each(['watch-first', 'creation-first'] as const)(
    'rejects stale fence incarnation after physical expiry deletion and revision-zero reuse: %s',
    async (order) => {
        const storage = await createResourceInboxTestStorage(`tournament_fence_${order}`);
        try {
            const test = await createViewWatchTestRuntime(storage);
            await seedExpiredFence(test);
            const pendingWatch = computeViewWatch(await test.service.read(tournamentWatch(test, 'captured-watch')));
            const pendingCreation = await prepareCreation(test);
            await storage.sql`delete from runtime_state_store where store_namespace=${TOURNAMENT_WATCH_FENCES_NAMESPACE} and expire_at_ts <= now()`;
            if (order === 'creation-first') {
                const creation = await prepareCreation(test);
                await storage.sql.begin((transaction) => test.tournamentService.write(transaction, creation));
                expect((await test.tournaments.readWatchFence(ref)).entry?.revision).toBe(0);
                await expect(storage.sql.begin((transaction) => writeViewWatch(transaction, pendingWatch))).rejects.toBeInstanceOf(
                    RuntimeStateWriteConflictError
                );
                await test.run(tournamentWatch(test, 'fresh-watch'));
            }
            else {
                await test.run(tournamentWatch(test, 'fresh-watch'));
                expect((await test.tournaments.readWatchFence(ref)).entry?.revision).toBe(0);
                await expect(storage.sql.begin((transaction) => test.tournamentService.write(transaction, pendingCreation))).rejects.toBeInstanceOf(
                    RuntimeStateWriteConflictError
                );
                const creation = await prepareCreation(test);
                await storage.sql.begin((transaction) => test.tournamentService.write(transaction, creation));
                expect((await notices(storage)).filter((notice) => notice.principalId === 'bob').map((notice) => notice.resource)).toEqual(['tournament']);
            }
            expect((await test.tournaments.readWatchFence(ref)).entry?.expireAtTimestamp).toBe(NEVER_EXPIRE_AT_TIMESTAMP);
            expect((await test.tournaments.readRecord(ref)).record?.tournament.entrants).toEqual([]);
        }
        finally {
            await storage.close();
        }
    }
);

it('retries a creation read torn by a competing creator before reading the promoted fence', async () => {
    const storage = await createResourceInboxTestStorage('tournament_creation_torn');
    try {
        const test = await createViewWatchTestRuntime(storage);
        const captured = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const readFence = test.tournaments.readWatchFence.bind(test.tournaments);
        const spy = vi.spyOn(test.tournaments, 'readWatchFence').mockImplementationOnce(async (identity) => {
            captured.resolve();
            await release.promise;
            return await readFence(identity);
        });
        const pending = prepareCreation(test);
        const observed = expect(pending).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        await captured.promise;
        const winner = await prepareCreation(test);
        await storage.sql.begin((transaction) => test.tournamentService.write(transaction, winner));
        release.resolve();
        await observed;
        spy.mockRestore();
        const retried = await prepareCreation(test);
        expect(retried.storage).toBeNull();
        expect((await test.tournaments.readRecord(ref)).record?.tournament.title).toBe('Unlisted cup');
    }
    finally {
        await storage.close();
    }
});

it('rolls back bracket creation, fence promotion and delivery proofs when the final view outbox insert fails', async () => {
    const storage = await createResourceInboxTestStorage('tournament_watch_rollback');
    try {
        const test = await createViewWatchTestRuntime(storage);
        await test.run(tournamentWatch(test, 'watch'));
        const fence = await test.tournaments.readWatchFence(ref);
        const creation = await prepareCreation(test);
        await storage.sql`create function reject_tournament_notice() returns trigger language plpgsql as
            'begin if NEW.ri_topic_id = ''view.invalidated'' then return null; end if; return NEW; end'`;
        await storage.sql`create trigger reject_tournament_notice before insert on resource_inbox for each row execute function reject_tournament_notice()`;
        await expect(storage.sql.begin((transaction) => test.tournamentService.write(transaction, creation))).rejects.toThrow();
        expect((await test.tournaments.readRecord(ref)).record).toBeNull();
        expect(await test.tournaments.readWatchFence(ref)).toEqual(fence);
        expect(await notices(storage)).toEqual([]);
        expect(await storage.sql`select store_key from runtime_state_store where store_namespace=${WS_OUTBOX_PROVENANCE_NAMESPACE}`).toEqual([]);
    }
    finally {
        await storage.close();
    }
});

function tournamentWatch(test: ViewWatchTestRuntime, requestId: string): ViewWatchCommand {
    const command = viewWatchCommand(test, requestId, null);
    return { ...command, family: 'tournament', request: { ...command.request, resourceId: ref.tournamentId } };
}

async function prepareCreation(test: ViewWatchTestRuntime): Promise<TournamentService.Computed> {
    const session = test.party.sessions.find((session) => session.clientId === 'alice')!;
    const command = test.tournamentService.materialize({
        ref,
        requestId: 'create-cup',
        actor: { principalId: session.clientId, sessionId: session.sessionId, issuedAtEpochMs: session.issuedAtEpochMs },
        request: { type: 'create', title: 'Unlisted cup' },
        materialized: null
    });
    const read = await test.tournamentService.read(command, { attemptCount: 1, traceId: 'create-unlisted-cup' });
    const computed = computeTournamentMutation(read);
    expect(test.tournamentService.validate(read, computed)).toEqual([]);
    return computed;
}

async function seedExpiredFence(test: ViewWatchTestRuntime): Promise<void> {
    const expiresAtEpochMs = Date.now() - 1000;
    await test.party.runtime.upsert({
        namespace: TOURNAMENT_WATCH_FENCES_NAMESPACE,
        key: toTournamentStorageKey(ref),
        value: JSON.stringify({ ref, expiresAtEpochMs, incarnation: 'expired-incarnation', phase: 'absent' }),
        expireAtTimestamp: expiresAtEpochMs
    });
}

async function notices(storage: ResourceInboxTestStorage): Promise<readonly ViewInvalidation[]> {
    const rows = await storage.sql<
        { ri_resource: string; }[]
    >`select ri_resource from resource_inbox where ri_topic_id='view.invalidated' order by ri_resource_id`;
    return rows.map((row) => decodeViewInvalidationMessage(decodePersistedALMessageValue(JSON.parse(row.ri_resource))));
}
