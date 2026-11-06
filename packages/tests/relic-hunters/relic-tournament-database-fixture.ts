import { decodeRelicSnapshotPayload, type RelicPublicSnapshot } from '@relic-hunters/mod.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { TOURNAMENT_ATTEMPTS_NAMESPACE, TournamentResultRepository } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { createTestAuthSession } from '../shared-server/rallar-system/group-state/group-state-test-runtime.ts';
import { connectGameSession, createGameFixture } from './relic-game-database-fixture.ts';

export interface TournamentGameFixture extends Awaited<ReturnType<typeof createGameFixture>> {
    readonly binding: TournamentMatchBinding;
    readonly guest: IssuedAuthSession;
    readonly tournaments: TournamentResultRepository;
}

export async function createTournamentGameFixture(): Promise<TournamentGameFixture> {
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
        {
            namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
            key: groupStateGroupStorageKey(game.ref),
            value: JSON.stringify({ binding, status: 'playing', startedAtEpochMs: game.nowEpochMs }),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        }
    );
    return Object.assign(game, { binding, guest, tournaments: new TournamentResultRepository(game.runtime) });
}

/** Reads the committed push publication without invoking a current-snapshot/REST repair path. */
export async function readTournamentGameSnapshots(game: TournamentGameFixture): Promise<readonly RelicPublicSnapshot[]> {
    const rows = await game.storage.sql<readonly { readonly resource: string; }[]>`
        select ri_resource as resource from resource_inbox
        where ri_type_id = 'WS_OUTBOX' and ri_topic_id = 'room.relic.snapshot'
    `;
    return rows.map((row) => {
        const message = decodePersistedALMessage(row.resource);
        return decodeRelicSnapshotPayload(JSON.parse(message.payload.resource)).fold(
            (error) => {
                throw error;
            },
            (snapshot) => snapshot
        );
    });
}
