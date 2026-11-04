import { ArenaTournamentMutation } from '@ar-eye-hunter/server/arena-tournament-mutation.ts';
import { ArenaTournamentSnapshotReader } from '@ar-eye-hunter/server/arena-tournament-room.ts';
import { AR_EYE_TOURNAMENT_RULES_ID } from '@ar-eye-hunter/tournament-arena.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { TOURNAMENT_ATTEMPTS_NAMESPACE, TournamentResultRepository } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { TournamentMatchBinding } from '@shared/api/tournaments/tournament-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import assert from 'node:assert/strict';
import {
    commitMutation,
    createRetentionDatabaseFixture,
    prepareMutation,
    requireMutationWrite,
    RETENTION_REF,
    seedRetentionRoom,
    type RetentionDatabaseFixture
} from '../../shared-server/rallar-system/group-state/retention/group-retention-database-fixture.ts';

export interface ArenaTournamentSqlFixture extends RetentionDatabaseFixture {
    readonly binding: TournamentMatchBinding;
    readonly attempt: TournamentResultRepository.Attempt;
    readonly service: ArenaTournamentMutation;
    readonly snapshots: ArenaTournamentSnapshotReader;
    readonly results: TournamentResultRepository;
    readonly sessions: AuthSessionPersistence;
    readonly data: RoomOwnedAppData;
    readonly dataBinding: RoomOwnedAppData.Binding;
}

export async function createArenaTournamentSqlFixture(ref: GroupRef = RETENTION_REF): Promise<ArenaTournamentSqlFixture> {
    const database = await createRetentionDatabaseFixture();
    await seedRetentionRoom(database, ref);
    const member = await prepareMutation(
        database,
        mutationDescriptor({
            operation: 'upsertMember',
            scope: ref,
            groupId: ref.groupId,
            targetPrincipalId: 'bob',
            request: { requestId: 'join-bob', status: 'active', actorPrincipalId: 'owner' }
        })
    );
    await commitMutation(database, requireMutationWrite(member.computed));
    const binding: TournamentMatchBinding = {
        tournamentRef: { applicationId: ref.applicationId, workspaceId: ref.workspaceId, tournamentId: 'cup' },
        slot: 'semifinal-1',
        attemptId: 'attempt-1',
        roomRef: ref,
        gameId: 'game-1',
        rulesId: AR_EYE_TOURNAMENT_RULES_ID,
        principalIds: ['owner', 'bob']
    };
    const attempt: TournamentResultRepository.Attempt = { binding, status: 'playing', startedAtEpochMs: database.nowEpochMs };
    await database.runtime.upsert({
        namespace: TOURNAMENT_ATTEMPTS_NAMESPACE,
        key: groupStateGroupStorageKey(ref),
        value: JSON.stringify(attempt),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    });
    const dataBinding = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        namespace: 'app:ar-eye',
        storeName: 'tournament-arenas'
    };
    const data = new RoomOwnedAppData(new PSqlAppDataRepository(database.storage.sql), [dataBinding]);
    const sessions = new AuthSessionPersistence(database.runtime);
    const results = new TournamentResultRepository(database.runtime);
    const service = new ArenaTournamentMutation({ groups: database.repository, sessions, results, data }, {
        nowEpochMs: () => database.nowEpochMs,
        serverId: 'ar-eye-owner'
    });
    const snapshots = new ArenaTournamentSnapshotReader(database.storage.sql, [dataBinding], () => database.nowEpochMs);
    return Object.assign(database, { binding, attempt, service, snapshots, results, sessions, data, dataBinding });
}

export async function commitArenaTournamentCommand(
    game: ArenaTournamentSqlFixture,
    command: ArenaTournamentMutation.Command
): Promise<ArenaTournamentMutation.Result> {
    const read = await game.service.read(command, 'arena-test');
    const computed = game.service.compute(read);
    assert.deepEqual(game.service.validate(read, computed), []);
    await game.storage.sql.begin((transaction) => game.service.write(transaction, computed));
    return computed.result;
}
