import { installMatchmakingDeadline } from '@shared-server/rallar-system/matchmaking/matchmaking-deadline.ts';
import { MatchmakingReader } from '@shared-server/rallar-system/matchmaking/matchmaking-reader.ts';
import { MatchmakingRepository } from '@shared-server/rallar-system/matchmaking/matchmaking-repository.ts';
import { MatchmakingService } from '@shared-server/rallar-system/matchmaking/matchmaking-service.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import type { MatchmakingRouteDependencies } from '../matchmaking/register-matchmaking-routes.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';

export interface ApiV1MatchmakingServicesInput {
    readonly configuration: ApiV1Configuration;
    readonly runtime: ApiV1Runtime;
    readonly runtimeStateRepository: RuntimeStateRepositoryLike;
    readonly serviceId: string;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink | undefined;
}

export function createApiV1MatchmakingServices(
    input: ApiV1MatchmakingServicesInput
): Omit<MatchmakingRouteDependencies, 'requireSession'> {
    const { configuration, runtime, runtimeStateRepository, nowEpochMs } = input;
    const repository = new MatchmakingRepository(runtimeStateRepository);
    const service = new MatchmakingService({
        appInbox: runtime.appInbox,
        repository,
        authSessions: runtime.authSessionRepository,
        groups: runtime.topologyServices.groupStateRepository,
        nowEpochMs,
        timing: input.timing
    }, {
        serviceId: input.serviceId,
        finishedRetentionMs: configuration.appInbox.finishedRetentionMs,
        defaultPolicy: configuration.matchmaking.defaultPolicy,
        policiesByApplication: configuration.matchmaking.policiesByApplication
    });
    installMatchmakingDeadline({
        outboxQueueReader: runtime.outboxQueueReader,
        nowEpochMs,
        enqueue: async (command, traceId) => {
            const admitted = await service.expire.enqueue({ command, traceId });
            if (admitted.left !== undefined) {
                throw new Error(admitted.left.message);
            }
        }
    });
    return {
        reader: new MatchmakingReader(repository, nowEpochMs),
        mutation: service.mutate,
        mutationQuota: new RateLimiterPolicy(
            configuration.matchmaking.rateLimit.windowMs,
            configuration.matchmaking.rateLimit.requests
        )
    };
}
