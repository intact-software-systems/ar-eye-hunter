import { RelicGameInboxService } from '@relic-hunters/server/relic-game-inbox-service.ts';
import {
    RELIC_ROOM_DATA_BINDING,
    RelicGameMutationService
} from '@relic-hunters/server/relic-game-mutation-service.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import type { RallarServerAppInbox } from '@shared-server/mod.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import type { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';

export interface RelicGameServices {
    readonly relicGameMutations: RelicGameMutationService;
    readonly relicGameInboxService: RelicGameInboxService;
}

export interface CreateRelicGameServicesInput {
    readonly database: PSqlSql;
    readonly groups: GroupStateRepository;
    readonly sessions: Pick<AuthSessionPersistence, 'findBySessionId'>;
    readonly roomOwnedAppDataBindings: readonly RoomOwnedAppData.Binding[];
    readonly serviceId: string;
    readonly appInbox: RallarServerAppInbox;
    readonly wakeQueue: () => void;
    readonly wsRuntimeName: string;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
}

export function createRelicGameServices(input: CreateRelicGameServicesInput): RelicGameServices {
    requireRelicRoomOwnedAppDataBindings(input.roomOwnedAppDataBindings);
    const relicGameMutations = new RelicGameMutationService({
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
    return { relicGameMutations, relicGameInboxService };
}

export function requireRelicRoomOwnedAppDataBindings(bindings: readonly RoomOwnedAppData.Binding[]): void {
    if (
        !bindings.some((binding) =>
            binding.applicationId === RELIC_ROOM_DATA_BINDING.applicationId &&
            binding.workspaceId === RELIC_ROOM_DATA_BINDING.workspaceId &&
            binding.namespace === RELIC_ROOM_DATA_BINDING.namespace &&
            binding.storeName === RELIC_ROOM_DATA_BINDING.storeName
        )
    ) {
        throw new Error('The complete database-wide room-owned catalog must include the exact Relic save binding');
    }
}
