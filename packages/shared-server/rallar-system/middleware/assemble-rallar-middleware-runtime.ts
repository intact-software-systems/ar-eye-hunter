import type {
    CreateRallarMiddlewareOptions,
    RallarMiddlewareInboxServices,
    RallarMiddlewareInfrastructure
} from './rallar-middleware-construction.ts';
import type {
    RallarMiddlewareQueueConstruction,
    RallarMiddlewareQueueTaskRegistration
} from './rallar-middleware-queue-construction.ts';
import type { RallarMiddlewareRuntime } from './rallar-middleware-runtime.ts';

export interface AssembleRallarMiddlewareRuntimeInput {
    readonly options: CreateRallarMiddlewareOptions;
    readonly queueConstruction: RallarMiddlewareQueueConstruction;
    readonly infrastructure: RallarMiddlewareInfrastructure;
    readonly inboxServices: RallarMiddlewareInboxServices;
    readonly queueTaskRegistration: RallarMiddlewareQueueTaskRegistration;
}

export function assembleRallarMiddlewareRuntime(
    input: AssembleRallarMiddlewareRuntimeInput
): RallarMiddlewareRuntime {
    const { options, infrastructure, inboxServices } = input;
    return {
        qboxEngine: input.queueConstruction.finalise(input.queueTaskRegistration),
        wsQBoxServerService: infrastructure.wsQBoxServerService,
        inboxQueueReader: infrastructure.inboxQueueReader,
        outboxQueueReader: infrastructure.outboxQueueReader,
        appInboxResilience: infrastructure.appInboxResilience,
        appOutboxResilience: infrastructure.appOutboxResilience,
        ...inboxServices,
        groupStateService: inboxServices.groupStateInboxService.groupStateService,
        clientStateService: inboxServices.appClientInboxService.clientStateService,
        clientsRepository: options.clientsRepository,
        groupsRepository: options.groupsRepository,
        rtcTopologyPublicationRepository: options.rtcTopologyPublicationRepository,
        rtcTopologyExecutionRepository: options.rtcTopologyExecutionRepository,
        rtcTopologyDelivery: options.rtcTopologyDelivery,
        rtcTopologyReplay: options.rtcTopologyReplay,
        readiness: Promise.all([
            options.readiness ?? Promise.resolve(),
            infrastructure.queuePubSubBridgeReadiness
        ]).then(() => undefined),
        healthFailure: options.healthFailure
    };
}
