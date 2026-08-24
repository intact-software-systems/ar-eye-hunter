import type {
    CreateRallarMiddlewareOptions,
    RallarMiddlewareInboxServices,
    RallarMiddlewareInfrastructure
} from './rallar-middleware-construction.ts';

export function createRallarMiddlewareInboxServices(
    options: CreateRallarMiddlewareOptions,
    infrastructure: RallarMiddlewareInfrastructure
): RallarMiddlewareInboxServices {
    const {
        inboxQueueReader,
        outboxQueueReader,
        wsQBoxServerService,
        appInboxResilience,
        appOutboxResilience,
        wakeQueueEngine
    } = infrastructure;
    const services: RallarMiddlewareInboxServices = {
        groupStateInboxService: options.createGroupStateInboxService({
            inboxQueueReader,
            outboxQueueReader,
            wsQBoxServerService,
            appInboxResilience,
            appOutboxResilience,
            wakeQueueEngine
        }),
        topologyInboxService: options.createTopologyInboxService({
            inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        rtcRttInboxService: options.createRtcRttInboxService({
            inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        appClientInboxService: options.createAppClientInboxService({
            inboxQueueReader,
            wsQBoxServerService,
            appInboxResilience,
            wakeQueueEngine
        }),
        appAuthInboxService: options.createAppAuthInboxService?.({
            inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        appAdminInboxService: options.createAppAdminInboxService?.({
            inboxQueueReader,
            outboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        appCrdtInboxService: options.createAppCrdtInboxService?.({
            inboxQueueReader,
            outboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        })
    };
    requireCompleteInboxServices(options, services);
    return services;
}

function requireCompleteInboxServices(
    options: CreateRallarMiddlewareOptions,
    services: RallarMiddlewareInboxServices
): void {
    if (
        !services.groupStateInboxService ||
        !services.topologyInboxService ||
        !services.rtcRttInboxService ||
        !services.appClientInboxService ||
        (options.createAppAuthInboxService !== undefined && services.appAuthInboxService === undefined) ||
        (options.createAppAdminInboxService !== undefined && services.appAdminInboxService === undefined) ||
        (options.createAppCrdtInboxService !== undefined && services.appCrdtInboxService === undefined)
    ) {
        throw new Error('Rallar middleware inbox service construction is incomplete');
    }
}
