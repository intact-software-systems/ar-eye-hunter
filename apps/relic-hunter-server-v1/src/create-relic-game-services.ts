import { RelicGameInboxService } from '@relic-hunters/server/relic-game-inbox-service.ts';
import {
    RELIC_ROOM_DATA_BINDING,
    RelicGameMutationService
} from '@relic-hunters/server/relic-game-mutation-service.ts';
import { installRelicTournamentClock } from '@relic-hunters/server/relic-tournament-deadline.ts';
import { RELIC_TOURNAMENT_GAME_PROFILE } from '@relic-hunters/server/relic-tournament.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { requireRoomOwnedAppDataBinding, RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import type { RallarServerAppInbox } from '@shared-server/mod.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { TournamentResultRepository } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { installTournamentGameStart } from '@shared-server/rallar-system/tournaments/tournament-signals.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

export interface RelicGameServices {
    readonly relicGameMutations: RelicGameMutationService;
    readonly relicGameInboxService: RelicGameInboxService;
}

export interface CreateRelicGameServicesInput {
    readonly database: PSqlSql;
    readonly groups: GroupStateRepository;
    readonly sessions: Pick<AuthSessionPersistence, 'findBySessionId' | 'readSessionBySessionIdEntry'>;
    readonly roomOwnedAppDataBindings: readonly RoomOwnedAppData.Binding[];
    readonly serviceId: string;
    readonly appInbox: RallarServerAppInbox;
    readonly outbox: OutboxQueueReader;
    readonly wakeQueue: () => void;
    readonly wsRuntimeName: string;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
}

export function createRelicGameServices(input: CreateRelicGameServicesInput): RelicGameServices {
    requireRoomOwnedAppDataBinding(input.roomOwnedAppDataBindings, RELIC_ROOM_DATA_BINDING);
    const relicGameMutations = new RelicGameMutationService({
        tournaments: new TournamentResultRepository(new PSqlRuntimeStateRepository(input.database)),
        groups: input.groups,
        sessions: input.sessions,
        data: new RoomOwnedAppData(new PSqlAppDataRepository(input.database), input.roomOwnedAppDataBindings)
    }, { now: input.nowEpochMs });
    const relicGameInboxService = new RelicGameInboxService({
        service: relicGameMutations,
        appInbox: input.appInbox,
        wakeQueue: input.wakeQueue
    }, {
        serviceId: input.serviceId,
        serverPeerId: input.wsRuntimeName,
        nowEpochMs: input.nowEpochMs,
        timing: input.timing
    });
    installRelicTournamentClock({ outbox: input.outbox, inbox: relicGameInboxService, nowEpochMs: input.nowEpochMs });
    installTournamentGameStart({
        outbox: input.outbox,
        topic: RELIC_TOURNAMENT_GAME_PROFILE.gameStartTopic,
        nowEpochMs: input.nowEpochMs,
        enqueue: async (binding, requestId, traceId, startedAtEpochMs) => {
            if (
                binding.rulesId !== RELIC_TOURNAMENT_GAME_PROFILE.rulesId ||
                binding.roomRef.applicationId !== RELIC_TOURNAMENT_GAME_PROFILE.scope.applicationId ||
                binding.roomRef.workspaceId !== RELIC_TOURNAMENT_GAME_PROFILE.scope.workspaceId
            ) {
                throw new TypeError('Relic start signal has unsupported rules or scope');
            }
            await relicGameInboxService.enqueueTournamentClock({
                operation: 'tournament-clock',
                gameId: binding.gameId,
                requestId,
                actor: null,
                authorization: 'tournament',
                move: null,
                clock: { phase: 'start', round: 1, dueAtEpochMs: startedAtEpochMs }
            }, traceId);
        }
    });
    return { relicGameMutations, relicGameInboxService };
}
