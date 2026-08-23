import { toStrictAppInboxQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { PSqlSql } from '../../../postgres/p-sql-sql.ts';
import { AppInboxHandlerRegistry } from '../../app-inbox/app-inbox-handler-registry.ts';
import {
    AppInboxIdempotencyConflictError,
    AppInboxQueueClient,
    AppInboxType,
    SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
    type AppInboxEnqueueInput,
    type AppInboxFailure,
    type AppInboxOptions
} from '../../app-inbox/app-inbox-queue-client.ts';
import type { IssuedAuthSession } from '../../auth/persistence/auth-session-types.ts';
import type { GroupStateService } from '../../group-state/group-state-service-contracts.ts';
import type { RallarTimingSink } from '../../observability/timing.ts';
import {
    readDurableTopologyAppInboxCommand,
    toPersistedTopologyHttpMutationSemanticHash,
    toTopologyAppInboxType,
    toTopologyHttpMutationContextId
} from './topology-app-inbox-command.ts';
import type { TopologyAppInboxCommand } from './topology-app-inbox-contracts.ts';
import {
    decodeTopologyAppInboxResult,
    TopologyAppInboxHandler,
    type TopologyAppInboxMutationOwners,
    type TopologyAppInboxResult
} from './topology-app-inbox-handler.ts';

const TOPOLOGY_CONFIG_INBOX_TYPES = [
    AppInboxType.TOPOLOGY_CONFIG_PUT,
    AppInboxType.TOPOLOGY_CONFIG_DELETE,
    AppInboxType.TOPOLOGY_OVERRIDE_PUT,
    AppInboxType.TOPOLOGY_OVERRIDE_DELETE,
    AppInboxType.TOPOLOGY_RECONFIGURE
] as const;

function isTopologyConfigInboxType(type: AppInboxType): boolean {
    return (TOPOLOGY_CONFIG_INBOX_TYPES as readonly AppInboxType[]).includes(type);
}

export namespace TopologyInboxService {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: AppInboxQueueClient.InboxRepository;
        readonly resourceInboxResultsRepository: AppInboxQueueClient.ResultRepository;
        readonly database: PSqlSql;
        readonly groupStateService: GroupStateService;
        readonly mutationOwners: TopologyAppInboxMutationOwners;
    }

    export interface Config {
        readonly serviceId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
        readonly wakeOwningQueue?: () => void;
    }

    export interface HttpCommandReservation {
        readonly operation: TopologyAppInboxCommand['operation'];
        readonly requestId: string;
        readonly callerId: string;
        readonly groupRef: TopologyAppInboxCommand['groupRef'];
        readonly semanticHash: string;
        readonly materialize: () => Promise<TopologyAppInboxCommand>;
    }
}

export class TopologyInboxService {
    private readonly queueClient: AppInboxQueueClient;
    private readonly handler: TopologyAppInboxHandler;

    constructor(
        dependencies: TopologyInboxService.Dependencies,
        config: TopologyInboxService.Config
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
        this.handler = new TopologyAppInboxHandler({
            groupStateService: dependencies.groupStateService,
            transactionWriter: handlers.transactionWriter,
            nowEpochMs: () => this.queueClient.nowEpochMs(),
            wakeQueue: config.wakeOwningQueue
        });
        for (const type of TOPOLOGY_CONFIG_INBOX_TYPES) {
            handlers.onStateMessage(
                type,
                async (_payload, context) => await this.handler.processMutation(context, dependencies.mutationOwners)
            );
        }
    }

    async processAuthenticatedEntryUntilCompletion<V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, TopologyAppInboxResult>> {
        return await this.processAuthenticatedEntryUntilCompletionResult(enqueue, authority);
    }

    async processAuthenticatedEntryUntilCompletionResult<V>(
        enqueue: AppInboxEnqueueInput<V>,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, TopologyAppInboxResult>> {
        if (!isTopologyConfigInboxType(enqueue.type)) {
            throw new TypeError('Topology AppInbox type is required');
        }
        return await this.queueClient.processEntryUntilCompletionResult(
            await this.handler.createAuthenticatedEnqueue(enqueue, authority),
            decodeTopologyAppInboxResult
        );
    }

    async processAuthenticatedHttpEntryUntilCompletionResult(
        reservation: TopologyInboxService.HttpCommandReservation,
        authority: IssuedAuthSession
    ): Promise<Either<AppInboxFailure, TopologyAppInboxResult>> {
        const currentSession = await this.handler.validateCurrentSession(
            reservation.callerId,
            authority
        );
        const type = toTopologyAppInboxType(reservation.operation);
        const key = toStrictAppInboxQueueKey({
            topicId: type,
            resourceId: reservation.requestId,
            contextId: toTopologyHttpMutationContextId(reservation.groupRef, reservation.callerId)
        });
        const reserved = await this.queueClient.reserveMaterializedEntry(
            {
                type,
                ...key,
                senderId: reservation.callerId,
                data: null
            },
            async () =>
                await this.handler.createAuthenticatedEnqueueFromValidatedSession(
                    {
                        type,
                        ...key,
                        senderId: reservation.callerId,
                        data: await reservation.materialize()
                    },
                    currentSession
                )
        );
        const command = readDurableTopologyAppInboxCommand(reserved.enqueue.data);
        if (
            command.operation !== reservation.operation ||
            command.requestId !== reservation.requestId ||
            command.actor.principalId !== reservation.callerId ||
            !sameGroupRef(command.groupRef, reservation.groupRef) ||
            reserved.enqueue.type !== type ||
            reserved.enqueue.topicId !== key.topicId ||
            reserved.enqueue.resourceId !== key.resourceId ||
            reserved.enqueue.contextId !== key.contextId ||
            reserved.enqueue.senderId !== reservation.callerId ||
            (await toPersistedTopologyHttpMutationSemanticHash(command)) !== reservation.semanticHash
        ) {
            throw new AppInboxIdempotencyConflictError(
                reservation.requestId,
                command.commandHash,
                reservation.semanticHash
            );
        }
        return await this.queueClient.waitForReservedEntryResult(
            reserved.enqueue,
            decodeTopologyAppInboxResult,
            reserved.winner
        );
    }
}

function sameGroupRef(
    left: TopologyAppInboxCommand['groupRef'],
    right: TopologyAppInboxCommand['groupRef']
): boolean {
    return (
        left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId
    );
}
