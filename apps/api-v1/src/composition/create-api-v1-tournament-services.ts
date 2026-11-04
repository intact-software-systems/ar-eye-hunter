import { TournamentCatalogReader } from '@shared-server/rallar-system/tournaments/catalog/tournament-catalog-reader.ts';
import { registerTournamentInbox } from '@shared-server/rallar-system/tournaments/register-tournament-inbox.ts';
import { TournamentReader } from '@shared-server/rallar-system/tournaments/tournament-reader.ts';
import { TournamentRepository } from '@shared-server/rallar-system/tournaments/tournament-repository.ts';
import { TournamentService } from '@shared-server/rallar-system/tournaments/tournament-service.ts';
import { installTournamentReconciliation } from '@shared-server/rallar-system/tournaments/tournament-signals.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import type { TournamentRouteDependencies } from '../tournaments/register-tournament-routes.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';

export interface ApiV1TournamentServicesInput {
    readonly configuration: ApiV1Configuration;
    readonly runtime: ApiV1Runtime;
    readonly runtimeStateRepository: RuntimeStateRepositoryLike;
    readonly serviceId: string;
    readonly nowEpochMs: () => number;
}

export function createApiV1TournamentServices(
    input: ApiV1TournamentServicesInput
): Omit<TournamentRouteDependencies, 'requireSession'> {
    const { runtime, configuration, nowEpochMs } = input;
    const repository = new TournamentRepository(input.runtimeStateRepository);
    const service = new TournamentService({
        repository,
        sessions: runtime.authSessionRepository,
        groups: runtime.topologyServices.groupStateRepository
    }, {
        profiles: configuration.tournaments.profiles,
        serviceId: input.serviceId,
        nowEpochMs,
        createId: () => crypto.randomUUID(),
        finishedRetentionMs: configuration.appInbox.finishedRetentionMs
    });
    const mutation = registerTournamentInbox({ appInbox: runtime.appInbox, service });
    installTournamentReconciliation({ outbox: runtime.outboxQueueReader, operation: mutation, nowEpochMs });
    return {
        catalog: new TournamentCatalogReader(input.runtimeStateRepository, nowEpochMs),
        reader: new TournamentReader(repository, nowEpochMs),
        mutation,
        mutationQuota: new RateLimiterPolicy(
            configuration.tournaments.rateLimit.windowMs,
            configuration.tournaments.rateLimit.requests
        )
    };
}
