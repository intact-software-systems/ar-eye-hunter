import { installArenaTournamentClock } from '@ar-eye-hunter/server/arena-tournament-deadline.ts';
import { registerArenaTournamentInbox } from '@ar-eye-hunter/server/arena-tournament-inbox.ts';
import {
    AR_EYE_TOURNAMENT_DATA_BINDING,
    ArenaTournamentMutation
} from '@ar-eye-hunter/server/arena-tournament-mutation.ts';
import { AR_EYE_TOURNAMENT_RULES_ID } from '@ar-eye-hunter/tournament-arena.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { requireRoomOwnedAppDataBinding, RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import type { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { TournamentResultRepository } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { installTournamentGameStart } from '@shared-server/rallar-system/tournaments/tournament-signals.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

export const ARENA_TOURNAMENT_GAME_PROFILE = {
    scope: {
        applicationId: AR_EYE_TOURNAMENT_DATA_BINDING.applicationId,
        workspaceId: AR_EYE_TOURNAMENT_DATA_BINDING.workspaceId
    },
    rulesId: AR_EYE_TOURNAMENT_RULES_ID,
    gameStartTopic: 'app:ar-eye:tournament-start'
};

export interface CreateArenaTournamentServicesInput {
    readonly database: PSqlSql;
    readonly groups: GroupStateRepository;
    readonly sessions: AuthSessionPersistence;
    readonly appInbox: RallarServerAppInbox;
    readonly outbox: OutboxQueueReader;
    readonly bindings: readonly RoomOwnedAppData.Binding[];
    readonly serviceId: string;
    readonly nowEpochMs: () => number;
}

export interface ArenaTournamentServices {
    readonly mutations: ArenaTournamentMutation;
    readonly operation: RallarServerAppInbox.Operation<ArenaTournamentMutation.Command, ArenaTournamentMutation.Result>;
}

export function createArenaTournamentServices(input: CreateArenaTournamentServicesInput): ArenaTournamentServices {
    const { bindings, database, nowEpochMs } = input;
    requireRoomOwnedAppDataBinding(bindings, AR_EYE_TOURNAMENT_DATA_BINDING);
    const mutations = new ArenaTournamentMutation({
        groups: input.groups,
        sessions: input.sessions,
        data: new RoomOwnedAppData(new PSqlAppDataRepository(database), bindings),
        results: new TournamentResultRepository(new PSqlRuntimeStateRepository(database))
    }, { nowEpochMs, serverId: input.serviceId });
    const operation = registerArenaTournamentInbox({ appInbox: input.appInbox, mutations, nowEpochMs });
    installArenaTournamentClock({ outbox: input.outbox, operation, nowEpochMs });
    installTournamentGameStart({
        outbox: input.outbox,
        topic: ARENA_TOURNAMENT_GAME_PROFILE.gameStartTopic,
        nowEpochMs,
        enqueue: async (binding, requestId, traceId) => {
            if (
                binding.rulesId !== AR_EYE_TOURNAMENT_RULES_ID ||
                binding.roomRef.applicationId !== AR_EYE_TOURNAMENT_DATA_BINDING.applicationId ||
                binding.roomRef.workspaceId !== AR_EYE_TOURNAMENT_DATA_BINDING.workspaceId
            ) {
                throw new TypeError('Arena start signal has unsupported rules or scope');
            }
            const admitted = await operation.enqueue({
                command: {
                    kind: 'tick',
                    roomRef: binding.roomRef,
                    requestId,
                    actor: null,
                    input: null,
                    capturedAtEpochMs: nowEpochMs()
                },
                traceId
            });
            if (admitted.left !== undefined) {
                throw new Error(admitted.left.message);
            }
        }
    });
    return { mutations, operation };
}
