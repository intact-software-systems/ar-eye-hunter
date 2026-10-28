import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    AppInboxIdempotencyConflictError,
    AppInboxType,
    type AppInboxEnqueueInput
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { normalizeAppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import {
    createAppInboxResourceEntry,
    createDefaultAppInboxQueueMessage
} from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { AppInboxCommandClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-command-client.ts';
import { AppInboxQueueEntryWriter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-queue-entry-writer.ts';
import { AppInboxReservationClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.ts';
import { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import { EntityStatus, toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { TestResourceInbox } from '../test-support/app-inbox-resource-fixtures.ts';

const COMMAND: AppInboxEnqueueInput = {
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    resourceId: 'command-1',
    contextId: 'app:workspace:principal',
    senderId: 'principal',
    traceId: 'trace-app-inbox-command-client',
    data: { requestId: 'command-1', principalId: 'principal' }
};

describe('AppInboxCommandClient', () => {
    it('passes the durable queue identity and the command trace to the wait and names the trace on its lines', async () => {
        const decodedValues: JsonWireValue[] = [];
        const timing: RallarTimingEvent[] = [];
        const client = new AppInboxCommandClient(
            {
                queueEntryWriter: {
                    writeIfAbsent: async (enqueue) => ({
                        entry: createAppInboxResourceEntry(
                            enqueue,
                            'server-12345678',
                            { creationNow: Temporal.Now.instant, createMessage: createDefaultAppInboxQueueMessage }
                        ),
                        winner: true
                    })
                },
                reservationClient: {
                    reserveMaterializedEntry: async () => {
                        throw new Error('An enqueued command reserves nothing');
                    }
                },
                resultWaiter: {
                    waitForResult: async <Result>(
                        written: AppInboxResultWaiter.Wait,
                        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
                    ) => {
                        expect(written.enqueue).toEqual(COMMAND);
                        expect(written.key).toEqual({ topicId: '', resourceId: 'command-1', contextId: 'app:workspace:principal' });
                        expect(written.winner).toBe(true);
                        expect(written.traceId).toBe('trace-app-inbox-command-client');
                        const value = { status: 'stored' } as const;
                        decodedValues.push(value);
                        return Either.ofRight(decodeResult(value));
                    }
                }
            },
            {
                serviceId: 'server-12345678',
                timing: (event) => timing.push(event),
                options: {
                    phaseTiming: true,
                    waitMaxElapsedMsecs: 1_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );

        const result = await client.enqueueAndWaitForResult({
            ...COMMAND,
            data: { requestId: 'command-1', principalId: 'principal' }
        }, (value) => ({
            accepted: typeof value === 'object' &&
                value !== null &&
                'status' in value &&
                value.status === 'stored'
        }));

        expect(result).toEqual(Either.ofRight({ accepted: true }));
        expect(decodedValues).toEqual([{ status: 'stored' }]);
        expect(timing.map((event) => `${event.component}:${event.operation}:${event.requestId}:${event.traceId}`)).toEqual([
            'app-inbox-phase:enqueue:command-1:trace-app-inbox-command-client',
            'app-inbox:enqueueAndWaitForResult:command-1:trace-app-inbox-command-client'
        ]);
    });

    it('lets a command it wrote take the wake of a handler that completes within the enqueue, while a replay reads first', async () => {
        const notifications = ResourceInboxCompletionNotifications.createDefault();
        const writtenKey = { topicId: 'app-inbox.client-state', resourceId: 'command-1', contextId: 'app:workspace:principal' };
        const reads: string[] = [];
        let wakes = 0;
        const wakeOwningQueue = () => {
            wakes += 1;
            notifications.publish(writtenKey, 'awaitable');
        };
        const options = normalizeAppInboxOptions({ phaseTiming: false, waitMaxElapsedMsecs: 1_000 });
        const client = new AppInboxCommandClient({
            queueEntryWriter: new AppInboxQueueEntryWriter({
                newResourceId: crypto.randomUUID.bind(crypto),
                createMessage: createDefaultAppInboxQueueMessage,
                inboxQueueReader: new InboxQueueReader(new TestResourceInbox(new Map()), {
                    newLaneConcurrency: 1
                })
            }, { serviceId: 'server-12345678', defaultTopicId: writtenKey.topicId, wakeOwningQueue }),
            reservationClient: {
                reserveMaterializedEntry: async () => {
                    throw new Error('An enqueued command reserves nothing');
                }
            },
            resultWaiter: new AppInboxResultWaiter({
                completionNotifications: notifications,
                statusRepository: {
                    readStatusAndAttempts: async () => {
                        reads.push('status');
                        return { status: EntityStatus.COMPLETED, attempts: 1 };
                    }
                },
                resultRepository: {
                    findByKey: async (key) => {
                        reads.push('result');
                        return { ...toResourceEntryWithKey(key, 'APP_INBOX', { status: 'stored' }), status: EntityStatus.COMPLETED };
                    }
                }
            }, { serviceId: 'server-12345678', options, wakeOwningQueue })
        }, { serviceId: 'server-12345678', options });

        await expect(client.enqueueAndWait(COMMAND)).resolves.toEqual(Either.ofRight({ status: 'stored' }));
        expect(reads).toEqual(['result']);
        await expect(client.enqueueAndWait(COMMAND)).resolves.toEqual(Either.ofRight({ status: 'stored' }));
        expect(reads).toEqual(['result', 'status', 'result']);
        expect(wakes).toBe(1);
    });

    it('reserves a materialized command once and rejects a different command under its key', async () => {
        const timing: RallarTimingEvent[] = [];
        const queue = new TestResourceInbox(new Map());
        const reservationClient = new AppInboxReservationClient({
            repository: queue,
            creationNow: Temporal.Now.instant,
            createMessage: createDefaultAppInboxQueueMessage
        }, { serviceId: 'server-12345678' });
        const reserved: AppInboxResultWaiter.Wait[] = [];
        const client = new AppInboxCommandClient(
            {
                queueEntryWriter: {
                    writeIfAbsent: async () => {
                        throw new Error('A reserved command is not written by the queue writer');
                    }
                },
                reservationClient,
                resultWaiter: {
                    waitForResult: async <Result>(
                        reservation: AppInboxResultWaiter.Wait,
                        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
                    ) => {
                        reserved.push(reservation);
                        return Either.ofRight(decodeResult({ status: 'stored' }));
                    }
                }
            },
            {
                serviceId: 'server-12345678',
                timing: (event) => timing.push(event),
                options: {
                    phaseTiming: true,
                    waitMaxElapsedMsecs: 1_000,
                    waitRetryIntervalMsecs: 1,
                    waitMaxRetryIntervalMsecs: 1,
                    waitJitterRatio: 0
                }
            }
        );
        const command = { ...COMMAND, topicId: COMMAND.type };
        const placeholder = { ...command, traceId: 'trace-reserved-placeholder', data: null };
        const reserve = (data: JsonWireValue) =>
            client.reserveMaterializedAndWaitForResult(
                { received: { ...command, data }, placeholder, materialize: async () => ({ ...command, data }) },
                (value) => value
            );

        await expect(reserve(COMMAND.data)).resolves.toEqual(Either.ofRight({ status: 'stored' }));
        await expect(reserve(COMMAND.data)).resolves.toEqual(Either.ofRight({ status: 'stored' }));
        await expect(reserve({ requestId: 'command-1', principalId: 'other-principal' })).rejects
            .toBeInstanceOf(AppInboxIdempotencyConflictError);

        expect(reserved.map(({ winner, traceId }) => ({ winner, traceId }))).toEqual([
            { winner: true, traceId: 'trace-reserved-placeholder' },
            { winner: false, traceId: 'trace-reserved-placeholder' }
        ]);
        expect(timing.map((event) => `${event.component}:${event.operation}:${event.requestId}:${event.traceId}`)).toEqual([
            'app-inbox-phase:enqueue:command-1:trace-reserved-placeholder',
            'app-inbox:enqueueAndWaitForResult:command-1:trace-reserved-placeholder',
            'app-inbox-phase:enqueue:command-1:trace-reserved-placeholder',
            'app-inbox:enqueueAndWaitForResult:command-1:trace-reserved-placeholder',
            'app-inbox-phase:enqueue:command-1:trace-reserved-placeholder',
            'app-inbox:enqueueAndWaitForResult:command-1:trace-reserved-placeholder'
        ]);
    });
});
