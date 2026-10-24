import { RelicGameInboxService } from '@relic-hunters/server/relic-game-inbox-service.ts';
import {
    RELIC_ROOM_DATA_BINDING,
    RelicGameMutationService
} from '@relic-hunters/server/relic-game-mutation-service.ts';
import { PSqlAppDataRepository } from '@shared-server/app-data/postgres/p-sql-app-data-repository.ts';
import { RoomOwnedAppData } from '@shared-server/app-data/room-owned-app-data.ts';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import type { RallarMiddlewareRuntime } from '@shared-server/rallar-system/middleware/rallar-middleware-runtime.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';

import type { ApiV1MutationRuntime } from './create-api-v1-mutation-runtime.ts';

export interface ApiV1RelicServices {
    readonly relicGameMutations: RelicGameMutationService;
    readonly relicGameInboxService: RelicGameInboxService;
}

export interface CreateApiV1RelicServicesInput {
    readonly mutation: ApiV1MutationRuntime;
    readonly runtime: Pick<RallarMiddlewareRuntime, 'inboxQueueReader' | 'qboxEngine'>;
    readonly wsRuntimeName: string;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink;
}

export function createApiV1RelicServices(input: CreateApiV1RelicServicesInput): ApiV1RelicServices {
    const { mutation, runtime } = input;
    const relicGameMutations = new RelicGameMutationService({
        groups: mutation.groupsRepository,
        sessions: new AuthSessionPersistence(mutation.runtimeStateRepository),
        data: new RoomOwnedAppData(new PSqlAppDataRepository(mutation.database), [RELIC_ROOM_DATA_BINDING])
    }, { now: input.nowEpochMs });
    const relicGameInboxService = new RelicGameInboxService({
        service: relicGameMutations,
        inboxQueueReader: runtime.inboxQueueReader,
        resourceInboxRepository: mutation.resourceInboxRepository.entries,
        resourceInboxResultsRepository: mutation.resourceInboxResultsRepository,
        database: mutation.database,
        wakeQueue: () => runtime.qboxEngine.wake()
    }, {
        serviceId: mutation.serviceId,
        serverPeerId: input.wsRuntimeName,
        timing: input.timing,
        options: mutation.appInboxOptions
    });
    return { relicGameMutations, relicGameInboxService };
}
