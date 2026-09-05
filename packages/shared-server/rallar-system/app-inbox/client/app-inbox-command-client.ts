import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';

import { timeRallarAsync, type RallarTimingDetails, type RallarTimingSink } from '../../observability/timing.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { AppInboxEnqueueInput } from '../app-inbox-contracts.ts';
import type { AppInboxFailure } from '../app-inbox-failure.ts';
import type { NormalizedAppInboxOptions } from '../app-inbox-options.ts';
import type { AppInboxResultWaiter } from './app-inbox-result-waiter.ts';

export namespace AppInboxCommandClient {
    export interface QueueEntryWriter {
        enqueue(enqueue: AppInboxEnqueueInput): Promise<ResourceEntry>;
        enqueueReplacingTerminal(enqueue: AppInboxEnqueueInput): Promise<Key>;
    }

    export interface ResultWaiter {
        waitForResult<Result>(
            enqueue: AppInboxEnqueueInput,
            key: Key,
            decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
        ): Promise<Either<AppInboxFailure, Result>>;
    }

    export interface Dependencies {
        readonly queueEntryWriter: QueueEntryWriter;
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
    private readonly resultWaiter: AppInboxCommandClient.ResultWaiter;
    private readonly serviceId: string;
    private readonly timing: RallarTimingSink | undefined;
    private readonly options: NormalizedAppInboxOptions;

    constructor(
        dependencies: AppInboxCommandClient.Dependencies,
        config: AppInboxCommandClient.Config
    ) {
        this.queueEntryWriter = dependencies.queueEntryWriter;
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
            const entry = await this.timeEnqueue(
                enqueue,
                async () => await this.queueEntryWriter.enqueue(enqueue)
            );
            return await this.resultWaiter.waitForResult(enqueue, entry.key, decodeResult);
        });
    }

    async enqueueReplacingTerminalAndWaitForResult<Result>(
        enqueue: AppInboxEnqueueInput,
        decodeResult: AppInboxResultWaiter.ResultDecoder<Result>
    ): Promise<Either<AppInboxFailure, Result>> {
        return await this.timeCommand(enqueue, async () => {
            const key = await this.timeEnqueue(
                enqueue,
                async () => await this.queueEntryWriter.enqueueReplacingTerminal(enqueue)
            );
            return await this.resultWaiter.waitForResult(enqueue, key, decodeResult);
        });
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
