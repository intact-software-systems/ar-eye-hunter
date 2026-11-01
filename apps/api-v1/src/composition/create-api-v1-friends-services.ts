import type { AuthUserRepository } from '@shared-server/rallar-system/auth/persistence/auth-user-repository.ts';
import { FriendsAccountDirectory } from '@shared-server/rallar-system/friends/friends-account-directory.ts';
import { FriendsReader } from '@shared-server/rallar-system/friends/friends-reader.ts';
import { FriendsRepository } from '@shared-server/rallar-system/friends/friends-repository.ts';
import { FriendsService } from '@shared-server/rallar-system/friends/friends-service.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';

import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import type { FriendsRouteDependencies } from '../friends/register-friends-routes.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';

export interface ApiV1FriendsServicesInput {
    readonly configuration: ApiV1Configuration;
    readonly runtime: ApiV1Runtime;
    readonly runtimeStateRepository: RuntimeStateRepositoryLike;
    readonly authUserRepository: AuthUserRepository;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink | undefined;
}

export function createApiV1FriendsServices(
    input: ApiV1FriendsServicesInput
): Omit<FriendsRouteDependencies, 'requireSession'> {
    const { configuration, runtime, authUserRepository, runtimeStateRepository, nowEpochMs } = input;
    const accounts = new FriendsAccountDirectory(
        authUserRepository,
        configuration.authentication.staticClients.map((account) => ({
            principalId: account.clientId,
            username: account.username,
            displayName: account.username
        }))
    );
    const profiles = new FriendsRepository(runtimeStateRepository);
    const service = new FriendsService({
        appInbox: runtime.appInbox,
        timing: input.timing,
        profiles,
        accounts,
        authSessions: runtime.authSessionRepository,
        groups: runtime.topologyServices.groupStateRepository,
        nowEpochMs
    }, configuration.friends);
    return {
        mutation: service.mutate,
        reader: new FriendsReader({ profiles, accounts, clients: runtime.clientStateService, nowEpochMs }),
        mutationQuota: new RateLimiterPolicy(
            configuration.friends.rateLimit.windowMs,
            configuration.friends.rateLimit.requests
        )
    };
}
