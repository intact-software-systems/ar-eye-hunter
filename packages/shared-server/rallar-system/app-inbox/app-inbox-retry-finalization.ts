import { Temporal } from '@js-temporal/polyfill';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import {
    writeResourceInboxReservationFinish,
    type ResourceInboxReservationFinish
} from '@shared-server/queuebox/postgres/resource-inbox-reservation-write.ts';
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
import { AppInboxReservationConflictError } from './app-inbox-contracts.ts';
import type { AppInboxFailure } from './app-inbox-failure.ts';
import {
    computeAppInboxResultReplacement,
    type AppInboxResultReplacement
} from './handler/app-inbox-completion-computation.ts';
import { writeAppInboxResultReplacement } from './handler/write-app-inbox-result-replacement.ts';

export type AppInboxRetryFinalization =
    | ResourceInboxRetryExhaustion
    | ResourceInboxRetryExhaustionRecovery;

export interface AppInboxRetryFinalizerDependencies {
    readonly database: PSqlSql;
    readonly timing?: RallarTimingSink;
}

interface AppInboxRetryFinalizationComputed {
    readonly finalization: AppInboxRetryFinalization;
    readonly finalizedEntry: ResourceEntry;
    readonly reservationFinish: ResourceInboxReservationFinish;
    readonly resultReplacement: AppInboxResultReplacement;
    readonly reservationConflict: AppInboxReservationConflictError;
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
        const computed = computeAppInboxRetryFinalization(finalization);
        return await timeRallarAsync(
            dependencies.timing,
            {
                component: 'app-inbox-phase',
                operation: 'transaction',
                requestId: finalization.entry.key.resourceId,
                details: computed.timingDetails
            },
            async () => await finalizeAppInboxRetry(dependencies, computed)
        );
    };
}

function computeAppInboxRetryFinalization(
    finalization: AppInboxRetryFinalization
): AppInboxRetryFinalizationComputed {
    const finalizedAtEpochMs = toFinalizedAtEpochMs(finalization);
    const diagnostics = toDiagnostics(finalization);
    const resultEntry = toResourceEntryWithUpdatedResource(
        finalization.entry,
        EntityStatus.FAILED,
        diagnostics
    );
    return {
        finalization,
        finalizedEntry: toFinalizedAppInboxEntry(finalization, finalizedAtEpochMs),
        reservationFinish: {
            key: finalization.entry.key,
            expectedAttempts: finalization.reservationAttempt,
            status: EntityStatus.FAILED,
            completedAt: new Date(finalizedAtEpochMs)
        },
        resultReplacement: computeAppInboxResultReplacement(resultEntry),
        reservationConflict: new AppInboxReservationConflictError(finalization.entry.key),
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
    computed: AppInboxRetryFinalizationComputed
): Promise<ResourceEntry> {
    return await timeRallarAsync(
        dependencies.timing,
        {
            component: 'app-inbox-phase',
            operation: 'write',
            requestId: computed.finalization.entry.key.resourceId,
            details: computed.timingDetails
        },
        async () =>
            await runInPSqlTransaction(dependencies.database, async (transaction) => {
                await writeAppInboxRetryFinalization(transaction, computed);
                return computed.finalizedEntry;
            })
    );
}

async function writeAppInboxRetryFinalization(
    transaction: PSqlSql,
    computed: AppInboxRetryFinalizationComputed
): Promise<void> {
    await writeAppInboxResultReplacement(transaction, computed.resultReplacement);
    const finished = await writeResourceInboxReservationFinish(transaction, computed.reservationFinish);
    if (!finished) {
        throw computed.reservationConflict;
    }
}

function toFinalizedAppInboxEntry(
    finalization: AppInboxRetryFinalization,
    finalizedAtEpochMs: number
): ResourceEntry {
    return {
        ...finalization.entry,
        status: EntityStatus.FAILED,
        dequeueAudit: {
            ...finalization.entry.dequeueAudit,
            endTs: Temporal.Instant.fromEpochMilliseconds(finalizedAtEpochMs),
            nextTs: undefined
        }
    };
}

function toDiagnostics(exhaustion: AppInboxRetryFinalization): AppInboxFailure {
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
