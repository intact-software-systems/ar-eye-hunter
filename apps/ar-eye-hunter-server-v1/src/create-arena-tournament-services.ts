import { ARENA_TOURNAMENT_SNAPSHOT_SENDER } from '@ar-eye-hunter/arena-tournament-stream.ts';
import { installArenaTournamentClock } from '@ar-eye-hunter/server/arena-tournament-deadline.ts';
import { registerArenaTournamentInbox } from '@ar-eye-hunter/server/arena-tournament-inbox.ts';
import {
    ArenaTournamentMutation
} from '@ar-eye-hunter/server/arena-tournament-mutation.ts';
import {
    ArenaTournamentPublication,
    installArenaTournamentFinishPublication,
    publishArenaTournamentSnapshot
} from '@ar-eye-hunter/server/arena-tournament-publication.ts';
import {
    AR_EYE_TOURNAMENT_DATA_BINDING,
    ArenaTournamentSnapshotReader
} from '@ar-eye-hunter/server/arena-tournament-room.ts';
import { AR_EYE_TOURNAMENT_RULES_ID } from '@ar-eye-hunter/tournament-arena.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { requireRoomOwnedAppDataBinding, RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { RallarServerAppInbox } from '@shared-server/rallar-server/rallar-server-app-inbox.ts';
import type { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { TournamentResultRepository } from '@shared-server/rallar-system/tournaments/tournament-result-repository.ts';
import { installTournamentGameLifecycle } from '@shared-server/rallar-system/tournaments/tournament-signals.ts';
import type { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { createDefaultBackgroundTimers } from '@shared/resilience/timers.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';

export const ARENA_TOURNAMENT_GAME_PROFILE = {
    scope: {
        applicationId: AR_EYE_TOURNAMENT_DATA_BINDING.applicationId,
        workspaceId: AR_EYE_TOURNAMENT_DATA_BINDING.workspaceId
    },
    rulesId: AR_EYE_TOURNAMENT_RULES_ID,
    gameLifecycleTopic: 'app:ar-eye:tournament-lifecycle'
};

export const ARENA_TOURNAMENT_SNAPSHOT_PRODUCER = {
    producerId: ARENA_TOURNAMENT_SNAPSHOT_SENDER,
    scope: ARENA_TOURNAMENT_GAME_PROFILE.scope
};

export interface CreateArenaTournamentServicesInput {
    readonly database: PSqlSql;
    readonly groups: GroupStateRepository;
    readonly sessions: AuthSessionPersistence;
    readonly appInbox: RallarServerAppInbox;
    readonly ws: Pick<RallarServerWsRouter, 'publish'>;
    readonly registerStop: (stop: () => Promise<void>) => void;
    readonly outbox: OutboxQueueReader;
    readonly bindings: readonly RoomOwnedAppData.Binding[];
    readonly serviceId: string;
    readonly nowEpochMs: () => number;
}

export interface ArenaTournamentServices {
    readonly snapshots: ArenaTournamentSnapshotReader;
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
    const snapshots = new ArenaTournamentSnapshotReader(database, bindings, nowEpochMs);
    const publisher = new ArenaTournamentPublication({
        timers: createDefaultBackgroundTimers(),
        read: (ref) => snapshots.readForPublication(ref),
        send: (snapshot) => publishArenaTournamentSnapshot(input.ws, snapshot)
    });
    input.registerStop(() => publisher.stop());
    const operation = registerArenaTournamentInbox({
        appInbox: input.appInbox,
        mutations,
        nowEpochMs,
        onCheckpointCommitted: (binding) => publisher.offer(binding)
    });
    installArenaTournamentFinishPublication({ outbox: input.outbox, publication: publisher, nowEpochMs });
    installArenaTournamentClock({ outbox: input.outbox, operation, nowEpochMs });
    installTournamentGameLifecycle({
        outbox: input.outbox,
        topic: ARENA_TOURNAMENT_GAME_PROFILE.gameLifecycleTopic,
        nowEpochMs,
        enqueue: async (binding, requestId, traceId, _dueAt, kind) => {
            if (
                binding.rulesId !== AR_EYE_TOURNAMENT_RULES_ID ||
                binding.roomRef.applicationId !== AR_EYE_TOURNAMENT_DATA_BINDING.applicationId ||
                binding.roomRef.workspaceId !== AR_EYE_TOURNAMENT_DATA_BINDING.workspaceId
            ) {
                throw new TypeError('Arena start signal has unsupported rules or scope');
            }
            if (kind === 'cancel') {
                await publisher.terminal(binding, 'cancelled');
                return;
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
    return { snapshots, operation };
}
