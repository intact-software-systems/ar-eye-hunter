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
import { timeRallarAsync, type RallarTimingDetails, type RallarTimingSink } from '../observability/timing.ts';
import { validateAppInboxCommandIdentity } from './app-inbox-command-identity.ts';
import { AppInboxReservationConflictError } from './app-inbox-contracts.ts';
import type { AppInboxFailure } from './app-inbox-failure.ts';

export type AppInboxRetryFinalization =
    | ResourceInboxRetryExhaustion
    | ResourceInboxRetryExhaustionRecovery;

export interface AppInboxRetryFinalizerDependencies {
    readonly database: PSqlSql;
    readonly timing?: RallarTimingSink;
}

interface AppInboxRetryFinalizationWork {
    readonly finalization: AppInboxRetryFinalization;
    readonly finalizedAtEpochMs: number;
    readonly finalizedAt: Date;
    readonly diagnostics: AppInboxFailure;
    readonly timingDetails: RallarTimingDetails;
}

export function createAppInboxRetryFinalizer(
    dependencies: AppInboxRetryFinalizerDependencies
): (finalization: AppInboxRetryFinalization) => Promise<ResourceEntry> {
    return async (finalization) => {
        if (finalization.reservationAttempt < finalization.processingAttempts) {
            throw new RangeError(
                'App inbox exhaustion reservation precedes the processing retry limit'
            );
        }
        const work = createAppInboxRetryFinalizationWork(finalization);
        return await timeRallarAsync(
            dependencies.timing,
            {
                component: 'app-inbox-phase',
                operation: 'transaction',
                requestId: finalization.entry.key.resourceId,
                details: work.timingDetails
            },
            async () => await finalizeAppInboxRetry(dependencies, work)
        );
    };
}

function createAppInboxRetryFinalizationWork(
    finalization: AppInboxRetryFinalization
): AppInboxRetryFinalizationWork {
    const finalizedAtEpochMs = toFinalizedAtEpochMs(finalization);
    return {
        finalization,
        finalizedAtEpochMs,
        finalizedAt: new Date(finalizedAtEpochMs),
        diagnostics: toDiagnostics(finalization),
        timingDetails: {
            processingAttempts: finalization.processingAttempts,
            reservationAttempt: finalization.reservationAttempt,
            selectedLane: finalization.lane,
            classification: finalization.classification,
            exhaustion: finalization.exhausted,
            queueAgeMs: finalization.queueAgeMs,
            dueAgeMs: finalization.dueAgeMs,
            source: finalization.failure.source
        }
    };
}

async function finalizeAppInboxRetry(
    dependencies: AppInboxRetryFinalizerDependencies,
    work: AppInboxRetryFinalizationWork
): Promise<ResourceEntry> {
    return await runInPSqlTransaction(dependencies.database, async (transaction) => {
        await writeAppInboxRetryFinalization(dependencies.timing, transaction, work);
        return toFinalizedAppInboxEntry(work);
    });
}

async function writeAppInboxRetryFinalization(
    timing: RallarTimingSink | undefined,
    transaction: PSqlSql,
    work: AppInboxRetryFinalizationWork
): Promise<void> {
    const finalizationRepository = new PSqlResourceInboxFinalizationRepository(transaction);
    const results = new ResourceInboxResultsRepository(transaction);
    await timeRallarAsync(
        timing,
        {
            component: 'app-inbox-phase',
            operation: 'write',
            requestId: work.finalization.entry.key.resourceId,
            details: work.timingDetails
        },
        async () => {
            await results.replace(toResourceEntryWithUpdatedResource(
                work.finalization.entry,
                EntityStatus.FAILED,
                work.diagnostics
            ));
            const finished = await finalizationRepository.finishReserved(
                work.finalization.entry.key,
                work.finalization.reservationAttempt,
                EntityStatus.FAILED,
                work.finalizedAt
            );
            if (!finished) {
                throw new AppInboxReservationConflictError(work.finalization.entry.key);
            }
        }
    );
}

function toFinalizedAppInboxEntry(work: AppInboxRetryFinalizationWork): ResourceEntry {
    return {
        ...work.finalization.entry,
        status: EntityStatus.FAILED,
        dequeueAudit: {
            ...work.finalization.entry.dequeueAudit,
            endTs: Temporal.Instant.fromEpochMilliseconds(work.finalizedAtEpochMs),
            nextTs: undefined
        }
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
