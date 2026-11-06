import type { AppDataEntry } from '@shared-server/app-data/app-data-repository.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { readPostgresSnapshot } from '@shared-server/postgres/read-postgres-snapshot.ts';
import { createTransactionBoundGroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { canReadGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import { TournamentResultRepository } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { createTransactionBoundPSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { requireExactKeys, requireRecord } from '@shared/api/exact-object-decoding.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { ArenaTournamentSnapshot } from '../arena-tournament-snapshot.ts';
import { ARENA_TOURNAMENT_SCOPE } from '../arena-tournament-stream.ts';
import { decodeTournamentArenaCheckpoint } from '../decode-tournament-arena-checkpoint.ts';
import {
    AR_EYE_TOURNAMENT_RULES_ID,
    type CreateTournamentArenaInput,
    type TournamentArena
} from '../tournament-arena.ts';
import type { ArenaTournamentMutation } from './arena-tournament-mutation.ts';

export const AR_EYE_TOURNAMENT_DATA_BINDING: RoomOwnedAppData.Binding = {
    ...ARENA_TOURNAMENT_SCOPE,
    namespace: 'app:ar-eye',
    storeName: 'tournament-arenas'
};

export class ArenaTournamentSnapshotReader {
    private readonly database: PSqlSql;
    private readonly bindings: readonly RoomOwnedAppData.Binding[];
    private readonly nowEpochMs: () => number;

    constructor(database: PSqlSql, bindings: readonly RoomOwnedAppData.Binding[], nowEpochMs: () => number) {
        this.database = database;
        this.bindings = bindings;
        this.nowEpochMs = nowEpochMs;
    }

    async readSnapshot(ref: GroupRef, principalId: string): Promise<ArenaTournamentSnapshot | null> {
        const room = await this.readCommittedRoom(ref);
        if (room.group === null) {
            return null;
        }
        const permission = canReadGroupSnapshot({
            snapshot: room.group.snapshot,
            actor: { principalId },
            nowEpochMs: this.nowEpochMs()
        });
        if (!permission.allowed) {
            throw new GroupPolicyDeniedError(permission);
        }
        return toArenaTournamentSnapshot(room, this.nowEpochMs());
    }

    /** Server publication has no client actor. Its authorized room audience is checked by the live WS sender. */
    async readForPublication(ref: GroupRef): Promise<ArenaTournamentSnapshot | null> {
        return toArenaTournamentSnapshot(await this.readCommittedRoom(ref), this.nowEpochMs());
    }

    private async readCommittedRoom(ref: GroupRef): Promise<ArenaTournamentMutation.Room> {
        return await readPostgresSnapshot(this.database, async (transaction) => {
            // The attempt revision orders every frame. Its checkpoint and group read permission must share that MVCC snapshot.
            return await readArenaTournamentRoom({
                groups: createTransactionBoundGroupStateRepository(transaction),
                data: new RoomOwnedAppData(new PSqlAppDataRepository(transaction), this.bindings),
                results: new TournamentResultRepository(createTransactionBoundPSqlRuntimeStateRepository(transaction))
            }, ref);
        });
    }
}

function toArenaTournamentSnapshot(
    room: ArenaTournamentMutation.Room,
    observedAtEpochMs: number
): ArenaTournamentSnapshot | null {
    if (room.group === null || room.tournament === null) {
        return null;
    }
    const { binding, attempt, attemptEntry } = room.tournament;
    if (attempt === null || attemptEntry === null) {
        throw new TypeError('Arena tournament attempt disappeared during its read');
    }
    return {
        binding,
        status: attempt.status,
        attemptRevision: attemptEntry.revision,
        observedAtEpochMs,
        state: room.state
    };
}

export async function readArenaTournamentRoom(
    dependencies: Pick<ArenaTournamentMutation.Dependencies, 'groups' | 'results' | 'data'>,
    ref: GroupRef
): Promise<ArenaTournamentMutation.Room> {
    const [group, tournament, saves] = await Promise.all([
        dependencies.groups.readSnapshotWithAuthorityGuard(ref),
        dependencies.results.readRoom(ref),
        dependencies.data.read(ref)
    ]);
    const save = saves.find(({ key }) =>
        key.namespace === AR_EYE_TOURNAMENT_DATA_BINDING.namespace &&
        key.storeName === AR_EYE_TOURNAMENT_DATA_BINDING.storeName && key.key === ref.groupId
    );
    if (save === undefined) {
        throw new TypeError('Arena tournament room-owned data binding is missing');
    }
    return {
        group: group ?? null,
        tournament,
        save,
        state: save.entry === null ? null : restoreTournamentArena(save.entry, ref, tournament)
    };
}

export function toTournamentArenaIdentity(tournament: TournamentResultRepository.Read): CreateTournamentArenaInput {
    const startedAtEpochMs = tournament.attempt?.startedAtEpochMs;
    if (
        startedAtEpochMs === null || startedAtEpochMs === undefined ||
        tournament.binding.rulesId !== AR_EYE_TOURNAMENT_RULES_ID
    ) {
        throw new TypeError('Arena tournament has no authorized native start');
    }
    return {
        gameId: tournament.binding.gameId,
        principalIds: tournament.binding.principalIds,
        startedAtEpochMs,
        durationMs: 60000,
        seed: Number.parseInt(computeSha256CanonicalJson(tournament.binding).slice(0, 8), 16)
    };
}

function restoreTournamentArena(
    entry: AppDataEntry,
    ref: GroupRef,
    tournament: TournamentResultRepository.Read | null
): TournamentArena {
    if (
        entry.key !== ref.groupId || entry.schemaVersion !== 1 ||
        entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP ||
        tournament === null
    ) {
        throw new TypeError('Arena tournament state storage identity or lifetime differs');
    }
    const stored = requireRecord(entry.value, 'Arena tournament stored state');
    requireExactKeys(stored, ['binding', 'state'], 'Arena tournament stored state');
    if (!jsonEquals(stored.binding, tournament.binding)) {
        throw new TypeError('Arena tournament state binding differs');
    }
    return decodeTournamentArenaCheckpoint(stored.state, toTournamentArenaIdentity(tournament));
}
