import { Either } from '@shared/resilience/Either.ts';

import { RETENTION_PLAN_TOKEN_MAX_LENGTH } from './retention-plan-token.ts';

export type RetentionCleanupQuery =
    | Readonly<{ mode: 'immediate'; }>
    | Readonly<{ mode: 'preview'; }>
    | Readonly<{ mode: 'confirm'; planToken: string; }>;

const PLAN_TOKEN_PATTERN = /^v1\.[0-9a-z]+\.[A-Za-z0-9_-]+$/;

export function decodeRetentionCleanupQuery(url: URL): Either<string, RetentionCleanupQuery> {
    const dryRunValues = url.searchParams.getAll('dryRun');
    const planTokenValues = url.searchParams.getAll('planToken');

    if (dryRunValues.length > 1 || planTokenValues.length > 1) {
        return Either.ofLeft('Retention preview and confirmation query values must not be duplicated.');
    }
    if (dryRunValues.length === 1 && planTokenValues.length === 1) {
        return Either.ofLeft('Retention preview and confirmation cannot be requested together.');
    }
    if (dryRunValues.length === 1) {
        return dryRunValues[0] === 'true'
            ? Either.ofRight({ mode: 'preview' })
            : Either.ofLeft('dryRun must be exactly true when provided.');
    }
    if (planTokenValues.length === 1) {
        const planToken = planTokenValues[0];
        return planToken.length <= RETENTION_PLAN_TOKEN_MAX_LENGTH && PLAN_TOKEN_PATTERN.test(planToken)
            ? Either.ofRight({ mode: 'confirm', planToken })
            : Either.ofLeft('planToken is malformed.');
    }
    return Either.ofRight({ mode: 'immediate' });
}
