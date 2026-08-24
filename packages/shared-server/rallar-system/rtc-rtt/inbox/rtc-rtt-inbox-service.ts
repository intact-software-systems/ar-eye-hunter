import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/app-inbox-handler-registry.ts';
import type { AppInboxOptions } from '../../app-inbox/app-inbox-options.ts';
import type { AppInboxEntryRepository, AppInboxResultRepository } from '../../app-inbox/app-inbox-persistence-ports.ts';
import { AppInboxQueueClient, SIMPLER_GROUP_STATE_APP_INBOX_TOPIC } from '../../app-inbox/app-inbox-queue-client.ts';
import { encodeAppInboxResult } from '../../app-inbox/app-inbox-registration-codecs.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import { readRtcRttAppInboxCommand } from './rtc-rtt-app-inbox-authority.ts';
import type { RtcRttAppInboxDependencies } from './rtc-rtt-app-inbox-contracts.ts';
import { RtcRttAppInboxHandler } from './rtc-rtt-app-inbox-handler.ts';

export namespace RtcRttInboxService {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: AppInboxEntryRepository;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
        readonly database: PSqlSql;
        readonly groupStateService: GroupStateService;
        readonly mutationDependencies: RtcRttAppInboxDependencies;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
    }
}

export class RtcRttInboxService {
    private readonly queueClient: AppInboxQueueClient;
    private readonly handler: RtcRttAppInboxHandler;

    constructor(
        dependencies: RtcRttInboxService.Dependencies,
        config: RtcRttInboxService.Config
    ) {
        this.queueClient = new AppInboxQueueClient(
            {
                inboxQueueReader: dependencies.inboxQueueReader,
                resourceInboxRepository: dependencies.resourceInboxRepository,
                resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository
            },
            {
                serviceId: config.serviceId,
                defaultTopicId: SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
                timing: config.timing,
                options: config.options,
                wakeOwningQueue: config.wakeOwningQueue
            }
        );
        const handlers = new AppInboxHandlerRegistry(
            {
                inboxQueueReader: dependencies.inboxQueueReader,
                resourceInboxResultsRepository: dependencies.resourceInboxResultsRepository,
                database: dependencies.database
            },
            {
                serviceId: config.serviceId,
                timing: config.timing,
                options: config.options
            }
        );
        this.handler = new RtcRttAppInboxHandler({
            groupStateService: dependencies.groupStateService,
            writeMutation: async (context, write) => await handlers.writeMutation(context, write),
            nowEpochMs: () => this.queueClient.nowEpochMs(),
            wakeQueue: config.wakeOwningQueue
        });
        handlers.registerHandler({
            type: AppInboxType.RTC_RTT_SUBMIT,
            decodeCommand: readRtcRttAppInboxCommand,
            encodeResult: (result) => encodeAppInboxResult(result, 'RTC RTT AppInbox result'),
            handle: async (_command, context) =>
                await this.handler.processMutation(context, dependencies.mutationDependencies)
        });
        handlers.assertRegistrationComplete([AppInboxType.RTC_RTT_SUBMIT]);
    }

    async enqueue(
        input: Readonly<{
            rtt: RttMeasurementInfo;
            alSenderId: string;
            capturedAtEpochMs: number;
        }>
    ): Promise<ResourceEntry> {
        return await this.queueClient.enqueue(await this.handler.createEnqueue(input));
    }
}
