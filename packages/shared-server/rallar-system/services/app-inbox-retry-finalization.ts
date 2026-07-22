import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    EntityStatus,
    type ResourceEntry,
    toResourceEntryWithUpdatedResource,
} from '@shared/queuebox/ResourceEntry.ts';
import type {
    ResourceInboxRetryExhaustion,
    ResourceInboxRetryExhaustionRecovery,
} from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { runInTransaction } from '@shared-server/postgres/run-in-transaction.ts';
import { AppInboxReservationConflictError, AppInboxType, type AppInboxEnqueueInput } from './app-inbox-contracts.ts';
import { classifyAppInboxError } from './app-inbox-error-classification.ts';
import { type RallarTimingSink, timeRallarAsync } from './timing.ts';

export type AppInboxRetryFinalization =
    | ResourceInboxRetryExhaustion
    | ResourceInboxRetryExhaustionRecovery;

export function createAppInboxRetryExhaustionHandler(options: Readonly<{
    database: PSqlSql;
    timing?: RallarTimingSink;
}>): (exhaustion: ResourceInboxRetryExhaustion) => Promise<ResourceEntry> {
    return createFinalizer(options);
}

export function createAppInboxRetryExhaustionRecoveryHandler(options: Readonly<{
    database: PSqlSql;
    timing?: RallarTimingSink;
}>): (exhaustion: ResourceInboxRetryExhaustionRecovery) => Promise<ResourceEntry> {
    return createFinalizer(options);
}

function createFinalizer(options: Readonly<{
    database: PSqlSql;
    timing?: RallarTimingSink;
}>): (exhaustion: AppInboxRetryFinalization) => Promise<ResourceEntry> {
    return async exhaustion => {
        if (exhaustion.reservationAttempt < exhaustion.processingAttempts) {
            throw new RangeError('App inbox exhaustion reservation precedes the processing retry limit');
        }
        const diagnostics = toDiagnostics(exhaustion);
        const details = {
            processingAttempts: exhaustion.processingAttempts,
            reservationAttempt: exhaustion.reservationAttempt,
            selectedLane: exhaustion.lane,
            classification: exhaustion.classification,
            exhaustion: exhaustion.exhausted,
            queueAgeMs: exhaustion.queueAgeMs,
            dueAgeMs: exhaustion.dueAgeMs,
            source: exhaustion.failure.source,
        } as const;
        return await timeRallarAsync(
            options.timing,
            {
                component: 'app-inbox-phase',
                operation: 'transaction',
                requestId: exhaustion.entry.key.resourceId,
                details,
            },
            async () => await runInTransaction(options.database, async transaction => {
                const resourceInbox = new ResourceInboxRepository(transaction);
                const results = new ResourceInboxResultsRepository(transaction);
                await timeRallarAsync(
                    options.timing,
                    {
                        component: 'app-inbox-phase',
                        operation: 'write',
                        requestId: exhaustion.entry.key.resourceId,
                        details,
                    },
                    async () => {
                        await results.replace(toResourceEntryWithUpdatedResource(
                            exhaustion.entry,
                            EntityStatus.FAILED,
                            diagnostics,
                        ));
                        const finished = await resourceInbox.finishReserved(
                            exhaustion.entry.key,
                            exhaustion.reservationAttempt,
                            EntityStatus.FAILED,
                            new Date(exhaustion.exhaustedAtEpochMs),
                        );
                        if (!finished) {
                            throw new AppInboxReservationConflictError(exhaustion.entry.key);
                        }
                    },
                );
                return {
                    ...exhaustion.entry,
                    status: EntityStatus.FAILED,
                    dequeueAudit: {
                        ...exhaustion.entry.dequeueAudit,
                        endTs: Temporal.Instant.fromEpochMilliseconds(
                            exhaustion.exhaustedAtEpochMs,
                        ),
                        nextTs: undefined,
                    },
                };
            }),
        );
    };
}

function toDiagnostics(exhaustion: AppInboxRetryFinalization) {
    return {
        type: 'app-inbox-retry-exhausted',
        commandIdentity: {
            contextId: exhaustion.entry.key.contextId,
            resourceId: exhaustion.entry.key.resourceId,
            topicId: exhaustion.entry.key.topicId,
            operation: readOperation(exhaustion.entry),
        },
        selectedLane: exhaustion.lane,
        processingAttempts: exhaustion.processingAttempts,
        reservationAttempt: exhaustion.reservationAttempt,
        lastError: exhaustion.failure.source === 'processing'
            ? toProcessingFailure(exhaustion.failure.error)
            : {
                source: 'finalization-recovery',
                code: 'app-inbox-finalization-recovery',
                message: 'AppInbox retry exhaustion finalization is being recovered',
            },
        queueAgeMs: exhaustion.queueAgeMs,
        dueAgeMs: exhaustion.dueAgeMs,
        exhaustedAtEpochMs: exhaustion.exhaustedAtEpochMs,
    } as const;
}

function toProcessingFailure(error: Error) {
    const classification = classifyAppInboxError(error);
    return {
        source: 'processing',
        code: classification.code,
        message: classification.kind === 'retryable'
            ? classification.message
            : 'AppInbox processing encountered a terminal failure',
    } as const;
}

function readOperation(entry: ResourceEntry): AppInboxType {
    const message = JSON.parse(entry.resource) as ALMessage;
    const command = JSON.parse(message.payload.resource) as AppInboxEnqueueInput<unknown>;
    if (!Object.values(AppInboxType).includes(command.type)) {
        throw new TypeError('App inbox exhaustion command operation is malformed');
    }
    return command.type;
}
