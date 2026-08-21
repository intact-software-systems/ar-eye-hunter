import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { runInTransaction } from '@shared-server/postgres/run-in-transaction.ts';
import type {
    ResourceInboxRetryExhaustion,
    ResourceInboxRetryExhaustionRecovery
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    toResourceEntryWithUpdatedResource,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { validateAppInboxCommandIdentity } from './app-inbox-command-identity.ts';
import { AppInboxReservationConflictError } from './app-inbox-contracts.ts';
import { classifyAppInboxError } from './app-inbox-error-classification.ts';
import { timeRallarAsync, type RallarTimingSink } from './timing.ts';

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
                await runInTransaction(options.database, async (transaction) => {
                    const resourceInbox = new ResourceInboxRepository(transaction);
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
                            const finished = await resourceInbox.finishReserved(
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

function toDiagnostics(exhaustion: AppInboxRetryFinalization) {
    const operationIdentity = validateAppInboxCommandIdentity(exhaustion.entry).identity;
    const timingIdentity = isProcessingFinalization(exhaustion)
        ? { exhaustedAtEpochMs: exhaustion.exhaustedAtEpochMs }
        : {
            selectedDueAtEpochMs: exhaustion.selectedDueAtEpochMs,
            finalizedAtEpochMs: exhaustion.finalizedAtEpochMs
        };
    return {
        type: 'app-inbox-retry-exhausted',
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
        },
        commandIdentity: {
            contextId: exhaustion.entry.key.contextId,
            resourceId: exhaustion.entry.key.resourceId,
            topicId: exhaustion.entry.key.topicId,
            ...operationIdentity
        },
        selectedLane: exhaustion.lane,
        processingAttempts: exhaustion.processingAttempts,
        reservationAttempt: exhaustion.reservationAttempt,
        lastError: exhaustion.failure.source === 'processing'
            ? toProcessingFailure(exhaustion.failure.error)
            : {
                source: 'finalization-recovery',
                code: 'app-inbox-finalization-recovery',
                message: 'AppInbox retry exhaustion finalization is being recovered'
            },
        queueAgeMs: exhaustion.queueAgeMs,
        dueAgeMs: exhaustion.dueAgeMs,
        ...timingIdentity
    } as const;
}

function toProcessingFailure(error: Error) {
    const classification = classifyAppInboxError(error);
    return {
        source: 'processing',
        code: classification.code,
        message: classification.kind === 'retryable'
            ? classification.message
            : 'AppInbox processing encountered a terminal failure'
    } as const;
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
