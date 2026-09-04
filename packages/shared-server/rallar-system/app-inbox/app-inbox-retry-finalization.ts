import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { writeResourceInboxReservationFinish } from '@shared-server/queuebox/postgres/resource-inbox-reservation-write.ts';
import { writeResourceInboxResultReplacement } from '@shared-server/queuebox/postgres/resource-inbox-result-replacement.ts';
import type {
    ResourceInboxRetryExhaustion,
    ResourceInboxRetryExhaustionRecovery
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { timeRallarAsync, type RallarTimingDetails, type RallarTimingSink } from '../observability/timing.ts';
import { validateAppInboxCommandIdentity } from './app-inbox-command-identity.ts';
import type { AppInboxFailure } from './app-inbox-failure.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed
} from './handler/app-inbox-completion-computation.ts';

export type AppInboxRetryFinalization =
    | ResourceInboxRetryExhaustion
    | ResourceInboxRetryExhaustionRecovery;

export interface AppInboxRetryFinalizerDependencies {
    readonly database: PSqlSql;
    readonly timing?: RallarTimingSink;
}

interface AppInboxRetryFinalizationWork {
    readonly completion: AppInboxCompletionComputed<AppInboxFailure>;
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
    const completionInput = {
        entry: finalization.entry,
        completedAtEpochMs: finalizedAtEpochMs,
        durableResult: toDiagnostics(finalization),
        status: EntityStatus.FAILED
    } as const;
    const completion = computeAppInboxCompletion(completionInput);
    const issues = validateAppInboxCompletion(completionInput, completion);
    if (issues[0] !== undefined) {
        throw issues[0].cause;
    }
    return {
        completion,
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
    await runInPSqlTransaction(dependencies.database, async (transaction) => {
        await writeAppInboxRetryFinalization(transaction, work.completion);
    });
    return work.completion.finalizedEntry;
}

async function writeAppInboxRetryFinalization(
    transaction: PSqlSql,
    computed: AppInboxCompletionComputed<AppInboxFailure>
): Promise<void> {
    await writeResourceInboxResultReplacement(transaction, computed.resultReplacement);
    if (!await writeResourceInboxReservationFinish(transaction, computed.reservationFinish)) {
        throw computed.reservationConflict;
    }
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
