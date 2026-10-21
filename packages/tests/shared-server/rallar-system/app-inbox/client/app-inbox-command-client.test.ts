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
import { createAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { AppInboxCommandClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-command-client.ts';
import { AppInboxReservationClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.ts';
import type { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import { TestResourceInbox } from '../test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxQueueMessageFixture } from '../test-support/create-app-inbox-queue-message-fixture.ts';

const COMMAND: AppInboxEnqueueInput = {
    type: AppInboxType.CLIENT_PRINCIPAL_UPSERT,
    resourceId: 'command-1',
    contextId: 'app:workspace:principal',
    senderId: 'principal',
    data: { requestId: 'command-1', principalId: 'principal' }
};

describe('AppInboxCommandClient', () => {
    it('passes the durable queue identity to the result decoding boundary', async () => {
        const decodedValues: JsonWireValue[] = [];
        const client = new AppInboxCommandClient(
            {
                queueEntryWriter: {
                    enqueue: async (enqueue) =>
                        createAppInboxResourceEntry(
                            enqueue,
                            'server-12345678',
                            { creationNow: Temporal.Now.instant, createMessage: createAppInboxQueueMessageFixture }
                        )
                },
                reservationClient: {
                    reserveMaterializedEntry: async () => {
                        throw new Error('An enqueued command reserves nothing');
                    }
                },
                resultWaiter: {
                    waitForReservedResult: async () => {
                        throw new Error('An enqueued command waits by its written key');
                    },
                    waitForResult: async <Result>(
                        enqueue: AppInboxEnqueueInput,
                        key: Key,
                        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
                    ) => {
                        expect(enqueue).toEqual(COMMAND);
                        expect(key).toEqual({ topicId: '', resourceId: 'command-1', contextId: 'app:workspace:principal' });
                        const value = { status: 'stored' } as const;
                        decodedValues.push(value);
                        return Either.ofRight(decodeResult(value));
                    }
                }
            },
            {
                serviceId: 'server-12345678',
                options: {
                    phaseTiming: false,
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
    });

    it('reserves a materialized command once and rejects a different command under its key', async () => {
        const timing: RallarTimingEvent[] = [];
        const queue = new TestResourceInbox(new Map());
        const reservationClient = new AppInboxReservationClient({
            repository: queue,
            creationNow: Temporal.Now.instant,
            createMessage: createAppInboxQueueMessageFixture
        }, { serviceId: 'server-12345678' });
        const reserved: AppInboxReservationClient.MaterializedReservation[] = [];
        const client = new AppInboxCommandClient(
            {
                queueEntryWriter: {
                    enqueue: async () => {
                        throw new Error('A reserved command is not written by the queue writer');
                    }
                },
                reservationClient,
                resultWaiter: {
                    waitForResult: async () => {
                        throw new Error('A reserved command waits for its reservation');
                    },
                    waitForReservedResult: async <Result>(
                        reservation: AppInboxReservationClient.MaterializedReservation,
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
        const placeholder = { ...command, data: null };
        const reserve = (data: JsonWireValue) =>
            client.reserveMaterializedAndWaitForResult(
                { received: { ...command, data }, placeholder, materialize: async () => ({ ...command, data }) },
                (value) => value
            );

        await expect(reserve(COMMAND.data)).resolves.toEqual(Either.ofRight({ status: 'stored' }));
        await expect(reserve(COMMAND.data)).resolves.toEqual(Either.ofRight({ status: 'stored' }));
        await expect(reserve({ requestId: 'command-1', principalId: 'other-principal' })).rejects
            .toBeInstanceOf(AppInboxIdempotencyConflictError);

        expect(reserved.map((reservation) => reservation.winner)).toEqual([true, false]);
        expect(timing.map((event) => `${event.component}:${event.operation}:${event.requestId}`)).toEqual([
            'app-inbox-phase:enqueue:command-1',
            'app-inbox:enqueueAndWaitForResult:command-1',
            'app-inbox-phase:enqueue:command-1',
            'app-inbox:enqueueAndWaitForResult:command-1',
            'app-inbox-phase:enqueue:command-1',
            'app-inbox:enqueueAndWaitForResult:command-1'
        ]);
    });
});
