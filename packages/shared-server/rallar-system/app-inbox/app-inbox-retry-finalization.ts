import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { PSqlResourceInboxFinalizationRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-finalization-repository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type {
    ResourceInboxRetryExhaustion,
    ResourceInboxRetryExhaustionRecovery
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { timeRallarAsync, type RallarTimingSink } from '../observability/timing.ts';
import { validateAppInboxCommandIdentity } from './app-inbox-command-identity.ts';
import { AppInboxReservationConflictError } from './app-inbox-contracts.ts';
import type { AppInboxFailure } from './app-inbox-failure.ts';

export type AppInboxRetryFinalization =
    | ResourceInboxRetryExhaustion
    | ResourceInboxRetryExhaustionRecovery;

export function createAppInboxRetryExhaustionHandler(
    options: Readonly<{
        database: PSqlSql;
        timing?: RallarTimingSink;
    }>
): (exhaustion: ResourceInboxRetryExhaustion) => Promise<ResourceEntry> {
    return createFinalizer(options);
}

export function createAppInboxRetryExhaustionRecoveryHandler(
    options: Readonly<{
        database: PSqlSql;
        timing?: RallarTimingSink;
    }>
): (exhaustion: ResourceInboxRetryExhaustionRecovery) => Promise<ResourceEntry> {
    return createFinalizer(options);
}

function createFinalizer(
    options: Readonly<{
        database: PSqlSql;
        timing?: RallarTimingSink;
    }>
): (exhaustion: AppInboxRetryFinalization) => Promise<ResourceEntry> {
    return async (exhaustion) => {
        if (exhaustion.reservationAttempt < exhaustion.processingAttempts) {
            throw new RangeError(
                'App inbox exhaustion reservation precedes the processing retry limit'
            );
        }
        const finalizedAtEpochMs = toFinalizedAtEpochMs(exhaustion);
        const diagnostics = toDiagnostics(exhaustion);
        const details = {
            processingAttempts: exhaustion.processingAttempts,
            reservationAttempt: exhaustion.reservationAttempt,
            selectedLane: exhaustion.lane,
            classification: exhaustion.classification,
            exhaustion: exhaustion.exhausted,
            queueAgeMs: exhaustion.queueAgeMs,
            dueAgeMs: exhaustion.dueAgeMs,
            source: exhaustion.failure.source
        } as const;
        return await timeRallarAsync(
            options.timing,
            {
                component: 'app-inbox-phase',
                operation: 'transaction',
                requestId: exhaustion.entry.key.resourceId,
                details
            },
            async () =>
                await runInPSqlTransaction(options.database, async (transaction) => {
                    const finalization = new PSqlResourceInboxFinalizationRepository(transaction);
                    const results = new ResourceInboxResultsRepository(transaction);
                    await timeRallarAsync(
                        options.timing,
                        {
                            component: 'app-inbox-phase',
                            operation: 'write',
                            requestId: exhaustion.entry.key.resourceId,
                            details
                        },
                        async () => {
                            await results.replace(toResourceEntryWithUpdatedResource(
                                exhaustion.entry,
                                EntityStatus.FAILED,
                                diagnostics
                            ));
                            const finished = await finalization.finishReserved(
                                exhaustion.entry.key,
                                exhaustion.reservationAttempt,
                                EntityStatus.FAILED,
                                new Date(finalizedAtEpochMs)
                            );
                            if (!finished) {
                                throw new AppInboxReservationConflictError(exhaustion.entry.key);
                            }
                        }
                    );
                    return {
                        ...exhaustion.entry,
                        status: EntityStatus.FAILED,
                        dequeueAudit: {
                            ...exhaustion.entry.dequeueAudit,
                            endTs: Temporal.Instant.fromEpochMilliseconds(
                                finalizedAtEpochMs
                            ),
                            nextTs: undefined
                        }
                    };
                })
        );
    };
}

function toDiagnostics(exhaustion: AppInboxRetryFinalization): AppInboxFailure {
    validateAppInboxCommandIdentity(exhaustion.entry);
    return {
        type: 'app-inbox-failure',
        code: 'app-inbox-retry-exhausted',
        status: 503,
        message: 'AppInbox processing exhausted its retry budget',
        issues: null,
        denial: null,
        retry: {
            kind: 'exhausted',
            attempts: exhaustion.processingAttempts,
            lane: exhaustion.lane,
            queueAgeMs: exhaustion.queueAgeMs,
            dueAgeMs: exhaustion.dueAgeMs
        }
    };
}

function toFinalizedAtEpochMs(exhaustion: AppInboxRetryFinalization): number {
    return isProcessingFinalization(exhaustion)
        ? exhaustion.exhaustedAtEpochMs
        : exhaustion.finalizedAtEpochMs;
}

function isProcessingFinalization(
    exhaustion: AppInboxRetryFinalization
): exhaustion is ResourceInboxRetryExhaustion {
    return exhaustion.failure.source === 'processing';
}
