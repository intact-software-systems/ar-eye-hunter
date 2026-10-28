import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { writeResourceInboxRetainedReservationFinish } from '@shared-server/queuebox/postgres/resource-inbox-reservation-write.ts';
import { writeResourceInboxResultReplacement } from '@shared-server/queuebox/postgres/resource-inbox-result-replacement.ts';
import type {
    ResourceInboxRetryExhaustion,
    ResourceInboxRetryExhaustionRecovery,
    ResourceInboxRetryFinalizer
} from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    recordRallarTiming,
    timeRallarAsync,
    type RallarTimingDetails,
    type RallarTimingSink
} from '../observability/timing.ts';
import { validateAppInboxCommandIdentity } from './app-inbox-command-identity.ts';
import { AppInboxReservationConflictError } from './app-inbox-contracts.ts';
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
    readonly finishedRetentionMs: number;
    readonly timing?: RallarTimingSink;
}

interface AppInboxRetryFinalizationWork {
    readonly completion: AppInboxCompletionComputed<AppInboxFailure>;
    readonly timingDetails: RallarTimingDetails;
}

export function createAppInboxRetryFinalizer(
    dependencies: AppInboxRetryFinalizerDependencies
): ResourceInboxRetryFinalizer<AppInboxRetryFinalization> {
    return async (finalization) => {
        if (finalization.reservationAttempt < finalization.processingAttempts) {
            throw new RangeError(
                'App inbox exhaustion reservation precedes the processing retry limit'
            );
        }
        const work = createAppInboxRetryFinalizationWork(finalization, dependencies.finishedRetentionMs);
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

/** The dequeuer's exhaustion telemetry holds the entry and no decoded message, so its line names no trace. */
export function recordAppInboxRetryExhaustionTiming(
    timing: RallarTimingSink | undefined,
    exhaustion: AppInboxRetryFinalization
): void {
    recordRallarTiming({
        sink: timing,
        event: {
            component: 'app-inbox-handler',
            operation: 'retry-exhaustion',
            requestId: exhaustion.entry.key.resourceId,
            details: {
                processingAttempts: exhaustion.processingAttempts,
                reservationAttempt: exhaustion.reservationAttempt,
                selectedLane: exhaustion.lane,
                classification: exhaustion.classification,
                exhaustion: exhaustion.exhausted,
                source: exhaustion.failure.source,
                queueAgeMs: exhaustion.queueAgeMs,
                dueAgeMs: exhaustion.dueAgeMs
            }
        },
        status: 'ok',
        durationMs: 0
    });
}

function createAppInboxRetryFinalizationWork(
    finalization: AppInboxRetryFinalization,
    finishedRetentionMs: number
): AppInboxRetryFinalizationWork {
    const finalizedAtEpochMs = toFinalizedAtEpochMs(finalization);
    const completionInput = {
        entry: finalization.entry,
        completedAtEpochMs: finalizedAtEpochMs,
        finishedRetentionMs,
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
    if (!await writeResourceInboxRetainedReservationFinish(transaction, computed.reservationFinish)) {
        throw new AppInboxReservationConflictError(computed.reservationFinish.key);
    }
    await writeResourceInboxResultReplacement(transaction, computed.resultReplacement);
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
