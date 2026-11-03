import { FriendsRepository } from '@shared-server/rallar-system/friends/friends-repository.ts';
import { MatchmakingRepository } from '@shared-server/rallar-system/matchmaking/matchmaking-repository.ts';
import type { RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { PartyReader } from '@shared-server/rallar-system/parties/party-reader.ts';
import { PartyService } from '@shared-server/rallar-system/parties/party-service.ts';
import { PartyRepository } from '@shared-server/rallar-system/parties/persistence/party-repository.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { RateLimiterPolicy } from '@shared/resilience/rate-limiter.ts';
import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import type { PartyRouteDependencies } from '../parties/register-party-routes.ts';
import type { ApiV1Runtime } from './api-v1-runtime.ts';

export interface ApiV1PartyServicesInput {
    readonly configuration: ApiV1Configuration;
    readonly runtime: ApiV1Runtime;
    readonly runtimeStateRepository: RuntimeStateRepositoryLike;
    readonly nowEpochMs: () => number;
    readonly timing: RallarTimingSink | undefined;
}

export function createApiV1PartyServices(
    input: ApiV1PartyServicesInput
): Omit<PartyRouteDependencies, 'requireSession'> {
    const { configuration, runtime, runtimeStateRepository, nowEpochMs } = input;
    const parties = new PartyRepository(runtimeStateRepository, nowEpochMs);
    const invitationPolicy = {
        maxInvitations: configuration.parties.maxInvitations,
        invitationLifetimeMs: configuration.parties.invitationLifetimeMs
    };
    const defaultPolicy = { ...invitationPolicy, maxMembers: configuration.matchmaking.defaultPolicy.players };
    const policiesByApplication = Object.fromEntries(
        Object.entries(configuration.matchmaking.policiesByApplication)
            .map(([applicationId, policy]) => [applicationId, { ...invitationPolicy, maxMembers: policy.players }])
    );
    const service = new PartyService({
        appInbox: runtime.appInbox,
        parties,
        matchmaking: new MatchmakingRepository(runtimeStateRepository),
        profiles: new FriendsRepository(runtimeStateRepository),
        authSessions: runtime.authSessionRepository,
        clients: runtime.clientsRepository,
        nowEpochMs,
        timing: input.timing
    }, { defaultPolicy, policiesByApplication, finishedRetentionMs: configuration.appInbox.finishedRetentionMs });
    return {
        mutation: service.mutate,
        reader: new PartyReader({ parties, clients: runtime.clientsRepository, nowEpochMs }, {
            defaultMaxMembers: defaultPolicy.maxMembers,
            maxMembersByApplication: Object.fromEntries(
                Object.entries(policiesByApplication).map((
                    [applicationId, policy]
                ) => [applicationId, policy.maxMembers])
            )
        }),
        mutationQuota: new RateLimiterPolicy(
            configuration.parties.rateLimit.windowMs,
            configuration.parties.rateLimit.requests
        )
    };
}
