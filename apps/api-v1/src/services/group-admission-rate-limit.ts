import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RateLimiterPolicy } from '@shared/resilience/Resilience.ts';
import type { ApiV1GroupAdmissionConfiguration } from '../configuration/api-v1-configuration.ts';

export type GroupAdmissionRateLimitFamily = 'join-admission' | 'presence-connect';

export interface GroupAdmissionRateLimitFamilyPolicies {
    readonly principal: RateLimiterPolicy;
    readonly group: RateLimiterPolicy;
}

export interface GroupAdmissionRateLimitConfig {
    readonly joinAdmission: GroupAdmissionRateLimitFamilyPolicies;
    readonly presenceConnect: GroupAdmissionRateLimitFamilyPolicies;
}

export interface GroupAdmissionQuota {
    require(input: GroupAdmissionQuotaInput): void;
}

export interface GroupAdmissionQuotaInput {
    readonly family: GroupAdmissionRateLimitFamily;
    readonly groupRef: GroupRef;
    readonly principalId: string;
}

export interface GroupAdmissionRateLimitDecisionInput {
    readonly family: GroupAdmissionRateLimitFamily;
    readonly groupRef: GroupRef;
    readonly principalId: string;
    readonly config: GroupAdmissionRateLimitConfig;
}

export type GroupAdmissionRateLimitDecision = 'allowed' | 'over-limit';

export class GroupAdmissionRateLimitedError extends Error {
    override readonly name = 'GroupAdmissionRateLimitedError';
    readonly status = 429;
    readonly code = 'group-admission-rate-limited';
    readonly retryAfterSeconds: number;
    readonly family: GroupAdmissionRateLimitFamily;

    constructor(family: GroupAdmissionRateLimitFamily, retryAfterSeconds: number) {
        super(`Too many group ${family} requests`);
        this.family = family;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

export function isGroupAdmissionRateLimitedError(
    error: unknown
): error is GroupAdmissionRateLimitedError {
    return error instanceof GroupAdmissionRateLimitedError;
}

export function createGroupAdmissionQuota(
    configuration: ApiV1GroupAdmissionConfiguration
): GroupAdmissionQuota {
    const config = toGroupAdmissionRateLimitConfig(configuration);
    const retryAfterSeconds = Math.ceil(configuration.windowMs / 1_000);
    return {
        require: (input) => {
            const decision = readGroupAdmissionRateLimitDecision({
                ...input,
                config
            });
            if (decision === 'over-limit') {
                throw new GroupAdmissionRateLimitedError(input.family, retryAfterSeconds);
            }
        }
    };
}

export function toGroupAdmissionRateLimitConfig(
    configuration: ApiV1GroupAdmissionConfiguration
): GroupAdmissionRateLimitConfig {
    return {
        joinAdmission: {
            principal: toWindowPolicy(configuration.windowMs, configuration.joinPrincipal),
            group: toWindowPolicy(configuration.windowMs, configuration.joinGroup)
        },
        presenceConnect: {
            principal: toWindowPolicy(configuration.windowMs, configuration.presencePrincipal),
            group: toWindowPolicy(configuration.windowMs, configuration.presenceGroup)
        }
    };
}

export function readGroupAdmissionRateLimitDecision(
    input: GroupAdmissionRateLimitDecisionInput
): GroupAdmissionRateLimitDecision {
    const policies = input.family === 'join-admission'
        ? input.config.joinAdmission
        : input.config.presenceConnect;
    const groupKey = toGroupKey(input.groupRef);
    const principalLimiter = readRateLimiter(
        `group-admission:${input.family}:principal`,
        `${groupKey}:${input.principalId}`,
        policies.principal
    );
    const groupLimiter = readRateLimiter(
        `group-admission:${input.family}:group`,
        groupKey,
        policies.group
    );
    if (!principalLimiter.isAllowed() || !groupLimiter.isAllowed()) {
        return 'over-limit';
    }
    principalLimiter.allow();
    groupLimiter.allow();
    return 'allowed';
}

function toWindowPolicy(windowMs: number, maxNumberToAllow: number): RateLimiterPolicy {
    return new RateLimiterPolicy(windowMs, maxNumberToAllow);
}

function toGroupKey(groupRef: GroupRef): string {
    return `${groupRef.applicationId}:${groupRef.workspaceId}:${groupRef.groupId}`;
}
