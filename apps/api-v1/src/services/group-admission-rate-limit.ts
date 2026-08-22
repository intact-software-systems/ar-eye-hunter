import { readRateLimiter } from '@shared-server/http/rate-limit-service.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RateLimiterPolicy } from '@shared/resilience/Resilience.ts';

export const GROUP_ADMISSION_RATE_LIMIT_WINDOW_MS = 60_000;
export const GROUP_ADMISSION_RETRY_AFTER_SECONDS = 60;

export type GroupAdmissionRateLimitFamily = 'join-admission' | 'presence-connect';

export interface GroupAdmissionRateLimitFamilyPolicies {
    readonly principal: RateLimiterPolicy;
    readonly group: RateLimiterPolicy;
}

export interface GroupAdmissionRateLimitConfig {
    readonly joinAdmission: GroupAdmissionRateLimitFamilyPolicies;
    readonly presenceConnect: GroupAdmissionRateLimitFamilyPolicies;
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
    readonly retryAfterSeconds = GROUP_ADMISSION_RETRY_AFTER_SECONDS;
    readonly family: GroupAdmissionRateLimitFamily;

    constructor(family: GroupAdmissionRateLimitFamily) {
        super(`Too many group ${family} requests`);
        this.family = family;
    }
}

export function isGroupAdmissionRateLimitedError(
    error: unknown
): error is GroupAdmissionRateLimitedError {
    return error instanceof GroupAdmissionRateLimitedError;
}

export function readGroupAdmissionRateLimitConfig(
    readEnv: (name: string) => string | undefined = readDenoEnv
): GroupAdmissionRateLimitConfig {
    return {
        joinAdmission: {
            principal: toWindowPolicy(
                readPositiveIntegerFromEnv(readEnv, 'RALLAR_GROUP_JOIN_ADMISSION_PRINCIPAL_RATE_LIMIT', 60)
            ),
            group: toWindowPolicy(
                readPositiveIntegerFromEnv(readEnv, 'RALLAR_GROUP_JOIN_ADMISSION_GROUP_RATE_LIMIT', 600)
            )
        },
        presenceConnect: {
            principal: toWindowPolicy(
                readPositiveIntegerFromEnv(
                    readEnv,
                    'RALLAR_GROUP_PRESENCE_CONNECT_PRINCIPAL_RATE_LIMIT',
                    120
                )
            ),
            group: toWindowPolicy(
                readPositiveIntegerFromEnv(readEnv, 'RALLAR_GROUP_PRESENCE_CONNECT_GROUP_RATE_LIMIT', 1200)
            )
        }
    };
}

const GROUP_ADMISSION_RATE_LIMIT_CONFIG = readGroupAdmissionRateLimitConfig();

/**
 * Route guard composing with (not replacing) the blanket `/api/state/*`
 * resilience middleware: it sheds a pathological storm on one group before the
 * mutation reaches the AppInbox. Throws the 429-bearing typed error so route
 * error mapping can answer with the contractual `Retry-After` header.
 */
export function requireGroupAdmissionQuota(
    family: GroupAdmissionRateLimitFamily,
    groupRef: GroupRef,
    principalId: string
): void {
    const decision = readGroupAdmissionRateLimitDecision({
        family,
        groupRef,
        principalId,
        config: GROUP_ADMISSION_RATE_LIMIT_CONFIG
    });
    if (decision === 'over-limit') {
        throw new GroupAdmissionRateLimitedError(family);
    }
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

function toWindowPolicy(maxNumberToAllow: number): RateLimiterPolicy {
    return new RateLimiterPolicy(GROUP_ADMISSION_RATE_LIMIT_WINDOW_MS, maxNumberToAllow);
}

function toGroupKey(groupRef: GroupRef): string {
    return `${groupRef.applicationId}:${groupRef.workspaceId}:${groupRef.groupId}`;
}

function readDenoEnv(name: string): string | undefined {
    try {
        return Deno.env.get(name);
    }
    catch {
        return undefined;
    }
}

function readPositiveIntegerFromEnv(
    readEnv: (name: string) => string | undefined,
    name: string,
    fallback: number
): number {
    const raw = readEnv(name)?.trim();
    if (!raw) {
        return fallback;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
    }

    return value;
}
