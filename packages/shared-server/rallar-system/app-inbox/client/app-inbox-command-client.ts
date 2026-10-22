import { Either } from '@shared/resilience/Either.ts';

import { timeRallarAsync, type RallarTimingDetails, type RallarTimingSink } from '../../observability/timing.ts';
import { serializeCanonicalMutationCommand, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput } from '../app-inbox-contracts.ts';
import type { AppInboxFailure } from '../app-inbox-failure.ts';
import type { NormalizedAppInboxOptions } from '../app-inbox-options.ts';
import { assertMatchingAppInboxEnqueue } from '../assert-matching-app-inbox-command.ts';
import { toLogicalAppInboxCommand } from '../logical-app-inbox-command.ts';
import type { AppInboxQueueEntryWriter } from './app-inbox-queue-entry-writer.ts';
import type { AppInboxReservationClient } from './app-inbox-reservation-client.ts';
import type { AppInboxResultWaiter } from './app-inbox-result-waiter.ts';

export namespace AppInboxCommandClient {
    export type QueueEntryWriter = Pick<AppInboxQueueEntryWriter, 'writeIfAbsent'>;

    export interface ResultWaiter {
        waitForResult<Result>(
            wait: AppInboxResultWaiter.Wait,
            decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
        ): Promise<Either<AppInboxFailure, Result>>;
    }

    export type ReservationClient = Pick<AppInboxReservationClient, 'reserveMaterializedEntry'>;

    /** A command whose volatile facts are materialized once, by the reservation that wins its queue key. */
    export interface MaterializedCommand {
        /** The command as received; whichever command the key keeps must be its logical twin. */
        readonly received: AppInboxEnqueueInput;
        readonly placeholder: AppInboxEnqueueInput;
        readonly materialize: () => Promise<AppInboxEnqueueInput>;
    }

    export interface Dependencies {
        readonly queueEntryWriter: QueueEntryWriter;
        readonly reservationClient: ReservationClient;
        readonly resultWaiter: ResultWaiter;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options: NormalizedAppInboxOptions;
    }
}

export class AppInboxCommandClient {
    private readonly queueEntryWriter: AppInboxCommandClient.QueueEntryWriter;
    private readonly reservationClient: AppInboxCommandClient.ReservationClient;
    private readonly resultWaiter: AppInboxCommandClient.ResultWaiter;
    private readonly serviceId: string;
    private readonly timing: RallarTimingSink | undefined;
    private readonly options: NormalizedAppInboxOptions;

    constructor(
        dependencies: AppInboxCommandClient.Dependencies,
        config: AppInboxCommandClient.Config
    ) {
        this.queueEntryWriter = dependencies.queueEntryWriter;
        this.reservationClient = dependencies.reservationClient;
        this.resultWaiter = dependencies.resultWaiter;
        this.serviceId = config.serviceId;
        this.timing = config.timing;
        this.options = config.options;
    }

    async enqueueAndWait(
        enqueue: AppInboxEnqueueInput
    ): Promise<Either<AppInboxFailure, JsonWireValue>> {
        return await this.enqueueAndWaitForResult(enqueue, (value) => value);
    }

    async enqueueAndWaitForResult<Result>(
        enqueue: AppInboxEnqueueInput,
        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
    ): Promise<Either<AppInboxFailure, Result>> {
        return await this.timeCommand(enqueue, async () => {
            const { entry, winner } = await this.timeEnqueue(
                enqueue,
                async () => await this.queueEntryWriter.writeIfAbsent(enqueue)
            );
            return await this.resultWaiter.waitForResult({ enqueue, key: entry.key, winner }, decodeResult);
        });
    }

    async reserveMaterializedAndWaitForResult<Result>(
        command: AppInboxCommandClient.MaterializedCommand,
        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
    ): Promise<Either<AppInboxFailure, Result>> {
        return await this.timeCommand(command.received, async () => {
            const reservation = await this.timeEnqueue(
                command.received,
                async () => await this.reserveMatchingEntry(command)
            );
            return await this.resultWaiter.waitForResult(reservation, decodeResult);
        });
    }

    private async reserveMatchingEntry(
        command: AppInboxCommandClient.MaterializedCommand
    ): Promise<AppInboxResultWaiter.Wait> {
        const receivedCommandIdentity = serializeCanonicalMutationCommand(toLogicalAppInboxCommand(command.received));
        const reservation = await this.reservationClient.reserveMaterializedEntry(
            command.placeholder,
            command.materialize
        );
        assertMatchingAppInboxEnqueue({
            resourceId: reservation.key.resourceId,
            existing: reservation.enqueue,
            incoming: command.received,
            receivedCommandIdentity
        });
        return reservation;
    }

    private async timeCommand<Result>(
        enqueue: AppInboxEnqueueInput,
        action: () => Promise<Result>
    ): Promise<Result> {
        const details = toTimingDetails(enqueue);
        return await timeRallarAsync(
            this.timing,
            {
                component: 'app-inbox',
                operation: 'enqueueAndWaitForResult',
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details
            },
            action
        );
    }

    private async timeEnqueue<Result>(
        enqueue: AppInboxEnqueueInput,
        action: () => Promise<Result>
    ): Promise<Result> {
        if (!this.options.phaseTiming) {
            return await action();
        }
        return await timeRallarAsync(
            this.timing,
            {
                component: 'app-inbox-phase',
                operation: 'enqueue',
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: toTimingDetails(enqueue)
            },
            action
        );
    }
}

function toTimingDetails(enqueue: AppInboxEnqueueInput): RallarTimingDetails {
    return {
        type: enqueue.type,
        topicId: enqueue.topicId,
        contextId: enqueue.contextId,
        resourceId: enqueue.resourceId,
        senderId: enqueue.senderId
    };
}
