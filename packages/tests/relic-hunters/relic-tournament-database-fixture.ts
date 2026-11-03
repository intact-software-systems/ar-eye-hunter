import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { TOURNAMENT_ATTEMPTS_NAMESPACE, TournamentResultRepository } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { createTestAuthSession } from '../shared-server/rallar-system/group-state/group-state-test-runtime.ts';
import { connectGameSession, createGameFixture } from './relic-game-database-fixture.ts';

export async function createTournamentGameFixture() {
    const game = await createGameFixture('tournament-expedition');
    const guest = createTestAuthSession('guest');
    await connectGameSession(game, game.owner);
    await connectGameSession(game, guest);
    const binding: TournamentMatchBinding = {
        tournamentRef: { applicationId: game.ref.applicationId, workspaceId: game.ref.workspaceId, tournamentId: 'cup' },
        slot: 'semifinal-1',
        attemptId: 'first-attempt',
        roomRef: game.ref,
        gameId: game.ref.groupId,
        rulesId: 'relic-native-10-rounds-v1',
        principalIds: [game.owner.clientId, guest.clientId]
    };
    await game.runtime.upsert(
        TOURNAMENT_ATTEMPTS_NAMESPACE,
        groupStateGroupStorageKey(game.ref),
        JSON.stringify({ binding, status: 'playing', startedAtEpochMs: game.nowEpochMs }),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
    return Object.assign(game, { binding, guest, tournaments: new TournamentResultRepository(game.runtime) });
}
